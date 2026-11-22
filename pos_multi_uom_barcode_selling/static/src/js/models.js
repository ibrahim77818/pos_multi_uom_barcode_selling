import { PosStore } from "@point_of_sale/app/services/pos_store";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { patch } from "@web/core/utils/patch";

// NOTE: no template literals in this module: Odoo's JS minifier can strip
// spaces inside them (seen in v16: "g(main unit)").

/**
 * Session-level index, built once from the data loaded at session start
 * (product.uom.barcode is loaded through pos.load.mixin). Scans and UoM
 * switches only read these Maps (no RPC per action).
 */
patch(PosStore.prototype, {
    async processServerData() {
        await super.processServerData(...arguments);
        this._mubBuildIndex();
    },

    _mubBuildIndex() {
        this.mubBarcodeIndex = new Map();
        this.mubUomIdsByProduct = new Map();
        if (!this.config.multi_uom_barcode_selling) {
            return;
        }
        const model = this.models["product.uom.barcode"];
        const records = model ? model.getAll() : [];
        for (const record of records) {
            const raw = record.raw || {};
            const productId = raw.product_id || (record.product_id && record.product_id.id);
            const uomId = raw.uom_id || (record.uom_id && record.uom_id.id);
            if (!record.barcode || !productId || !uomId || !this.models["uom.uom"].get(uomId)) {
                continue;
            }
            this.mubBarcodeIndex.set(record.barcode, { productId, uomId });
            if (!this.mubUomIdsByProduct.has(productId)) {
                this.mubUomIdsByProduct.set(productId, new Set());
            }
            this.mubUomIdsByProduct.get(productId).add(uomId);
        }
    },

    mubIsEnabled() {
        return Boolean(this.config && this.config.multi_uom_barcode_selling);
    },

    mubFindBarcode(code) {
        if (!code || !this.mubBarcodeIndex) {
            return undefined;
        }
        return this.mubBarcodeIndex.get(code);
    },

    /** Main UoM first, then the secondary UoMs that have a UoM barcode. */
    mubGetProductUomIds(product) {
        const mainId = product.uom_id ? product.uom_id.id : false;
        const ids = mainId ? [mainId] : [];
        const extra = this.mubUomIdsByProduct && this.mubUomIdsByProduct.get(product.id);
        if (extra) {
            for (const id of extra) {
                if (id !== mainId) {
                    ids.push(id);
                }
            }
        }
        return ids;
    },
});

patch(PosOrderline.prototype, {
    setup(vals) {
        super.setup(...arguments);
        // Refund lines are created directly by the ticket screen: keep the
        // unit of the refunded line (its price is kept by standard).
        if (this.product_id && !this.product_uom_id && this.refunded_orderline_id &&
                this.refunded_orderline_id.product_uom_id) {
            this.product_uom_id = this.refunded_orderline_id.product_uom_id;
        }
    },

    /** Secondary UoM of the line, or false when sold in the main UoM. */
    get mubUom() {
        const uom = this.product_id && this.product_uom_id;
        const main = this.product_id && this.product_id.uom_id;
        if (!uom || !main || uom.id === main.id) {
            return false;
        }
        return uom;
    },

    getUnit() {
        return this.mubUom || super.getUnit(...arguments);
    },

    isPosGroupable() {
        const uom = this.mubUom;
        if (!uom) {
            return super.isPosGroupable(...arguments);
        }
        return Boolean(uom.is_pos_groupable) && !this.isPartOfCombo();
    },

    /**
     * Main-UoM quantity represented by one unit of the line UoM.
     * Odoo 19: uom.factor is the absolute quantity of the reference unit
     * (g = 1, kg = 1000, t = 1,000,000), so 1 kg = 1000 / 1 g.
     */
    get_mub_ratio() {
        const uom = this.mubUom;
        const main = this.product_id && this.product_id.uom_id;
        if (!uom || !main || !uom.factor || !main.factor) {
            return 1;
        }
        return uom.factor / main.factor;
    },

    /** Line quantity expressed in the product's main UoM. */
    get_mub_base_quantity() {
        return this.getQuantity() * this.get_mub_ratio();
    },

    /**
     * The pricelist is evaluated on the main-UoM quantity (min_quantity keeps
     * its meaning) and the main-UoM price is converted to the line UoM:
     * 1 GM = 1 USD  =>  1 KG = 1000 USD.
     */
    _mubComputeUnitPrice(quantity) {
        const ratio = this.get_mub_ratio();
        const qty = quantity === undefined ? this.getQuantity() : quantity;
        const basePrice = this.product_id.product_tmpl_id.getPrice(
            this.order_id.pricelist_id,
            qty * ratio,
            this.getPriceExtra() || 0,
            false,
            this.product_id
        );
        return basePrice * ratio;
    },

    /**
     * Lines whose price must never be recomputed from the pricelist:
     * hand-set prices ("manual"), refund lines ("automatic"), refunds,
     * rewards and combo lines.
     */
    _mubIsPriceLocked() {
        return Boolean(
            this.price_type !== "original" ||
                this.refunded_orderline_id ||
                this.is_reward_line ||
                this.combo_parent_id ||
                (this.combo_line_ids && this.combo_line_ids.length)
        );
    },

    _mubRecomputePrice() {
        if (!this.mubUom || !this.order_id || this._mubIsPriceLocked()) {
            return;
        }
        this.setUnitPrice(this._mubComputeUnitPrice());
    },

    setQuantity(quantity, keep_price) {
        // Odoo 19 rounds every unit with the same "Product Unit" precision,
        // so no re-rounding is needed for the line UoM.
        const result = super.setQuantity(...arguments);
        if (result === true && !keep_price && this.order_id) {
            // Standard re-prices this line (and, for lot-tracked products, every
            // line of the product) with the main-UoM price: restore UoM prices.
            this.order_id._mubRecomputeProductLines(this.product_id);
        }
        return result;
    },

    setOptions(options) {
        super.setOptions(...arguments);
        // New lines get the main-UoM price from addLineToOrder: convert it
        // before the merge check runs.
        if (this.order_id) {
            this.order_id._mubRecomputeProductLines(this.product_id);
        }
    },

    canBeMergedWith(orderline) {
        const uom = this.mubUom;
        const otherUom = orderline.mubUom;
        if ((uom ? uom.id : false) !== (otherUom ? otherUom.id : false)) {
            return false;
        }
        if (!uom) {
            return super.canBeMergedWith(...arguments);
        }
        // Standard compares the line price with the main-UoM product price,
        // which never matches for a secondary UoM: same rules, UoM price.
        const ProductPrice = this.models["decimal.precision"].find(
            (dp) => dp.name === "Product Price"
        );
        const expected = orderline._mubComputeUnitPrice(this.getQuantity());
        const sameNote =
            (!orderline.getCustomerNote() && !this.getCustomerNote()) ||
            orderline.getCustomerNote() === this.getCustomerNote();
        return (
            orderline.getNote() === this.getNote() &&
            this.getProduct().id === orderline.getProduct().id &&
            this.isPosGroupable() &&
            this.getDiscount() === 0 &&
            orderline.getDiscount() === 0 &&
            this.price_type === orderline.price_type &&
            !this._mubIsPriceLocked() &&
            !orderline._mubIsPriceLocked() &&
            ProductPrice.isZero(ProductPrice.round(this.price_unit || 0) - ProductPrice.round(expected)) &&
            !this.isLotTracked() &&
            this.full_product_name === orderline.full_product_name &&
            sameNote &&
            !orderline.isPartOfCombo()
        );
    },

    /**
     * Switch the line UoM. The quantity number is kept and the price is
     * converted: recomputed from the pricelist, or, for manually priced
     * lines, converted proportionally.
     */
    mubSetUom(uom) {
        this.order_id.assertEditable();
        const main = this.product_id.uom_id;
        const newUom = uom && main && uom.id !== main.id ? uom : false;
        const oldUom = this.mubUom || false;
        if ((newUom ? newUom.id : false) === (oldUom ? oldUom.id : false)) {
            return false;
        }
        const fromUom = oldUom || main;
        const toUom = newUom || main;
        const manualPrice = this.price_type !== "original";
        const oldPrice = this.price_unit;

        this.product_uom_id = newUom || main;
        this.setQuantity(this.getQuantity(), true);

        if (manualPrice) {
            // Price per new unit = price per old unit x old units in one new unit.
            this.setUnitPrice(oldPrice * (toUom.factor / fromUom.factor));
        } else if (newUom) {
            this._mubRecomputePrice();
        } else {
            this.setUnitPrice(
                this.product_id.product_tmpl_id.getPrice(
                    this.order_id.pricelist_id,
                    this.getQuantity(),
                    this.getPriceExtra(),
                    false,
                    this.product_id
                )
            );
        }
        return true;
    },
});

patch(PosOrder.prototype, {
    setPricelist(pricelist) {
        const result = super.setPricelist(...arguments);
        for (const line of this.lines || []) {
            if (line.mubUom) {
                line._mubRecomputePrice();
            }
        }
        return result;
    },

    _mubRecomputeProductLines(product) {
        if (!product) {
            return;
        }
        for (const line of this.lines || []) {
            if (line.mubUom && line.product_id && line.product_id.id === product.id) {
                line._mubRecomputePrice();
            }
        }
    },
});
