import { PosStore } from "@point_of_sale/app/store/pos_store";
import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { patch } from "@web/core/utils/patch";
import { roundDecimals, roundPrecision } from "@web/core/utils/numbers";
import { parseFloat as oParseFloat } from "@web/views/fields/parsers";

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

    /** Same formula as uom.uom._compute_quantity (without rounding). */
    mubConvertQty(qty, fromUom, toUom) {
        if (!fromUom || !toUom || fromUom.id === toUom.id || !fromUom.factor || !toUom.factor) {
            return qty;
        }
        return (qty / fromUom.factor) * toUom.factor;
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

    /**
     * Always send the sold unit when the order is saved. The server field is
     * a plain stored field (so standard sends it); this guards against the
     * field being described as computed/related, which the ORM serialization
     * skips (seen in the first v18 build: Dozens saved as Units).
     */
    serialize(options = {}) {
        const data = super.serialize(...arguments);
        if (options.orm && this.product_uom_id && !data.product_uom_id) {
            data.product_uom_id = this.product_uom_id.id;
        }
        return data;
    },

    /** Secondary UoM of the line, or false when sold in the main UoM. */
    get mubUom() {
        const uom = this.product_uom_id;
        const main = this.product_id && this.product_id.uom_id;
        if (!uom || !main || uom.id === main.id) {
            return false;
        }
        return uom;
    },

    get_unit() {
        return this.mubUom || super.get_unit(...arguments);
    },

    is_pos_groupable() {
        const uom = this.mubUom;
        if (!uom) {
            return super.is_pos_groupable(...arguments);
        }
        return Boolean(uom.is_pos_groupable) && !this.isPartOfCombo();
    },

    get_quantity_str_with_unit() {
        const uom = this.mubUom;
        if (!uom) {
            return super.get_quantity_str_with_unit(...arguments);
        }
        return this.quantityStr + " " + uom.name;
    },

    getDisplayData() {
        const data = super.getDisplayData(...arguments);
        const uom = this.mubUom;
        if (uom) {
            data.unit = uom.name;
            // Rendered as a badge by the Orderline component (screen and receipt).
            data.mubUomName = uom.name;
        }
        return data;
    },

    /** Main-UoM quantity represented by one unit of the line UoM. */
    get_mub_ratio() {
        const uom = this.mubUom;
        if (!uom) {
            return 1;
        }
        const main = this.product_id.uom_id;
        return main && uom.factor && main.factor ? (1 / uom.factor) * main.factor : 1;
    },

    /** Line quantity expressed in the product's main UoM. */
    get_mub_base_quantity() {
        return this.get_quantity() * this.get_mub_ratio();
    },

    /**
     * The pricelist is evaluated on the main-UoM quantity (min_quantity keeps
     * its meaning) and the main-UoM price is converted to the line UoM:
     * 1 GM = 1 USD  =>  1 KG = 1000 USD.
     */
    _mubComputeUnitPrice(quantity) {
        const ratio = this.get_mub_ratio();
        const qty = quantity === undefined ? this.get_quantity() : quantity;
        const basePrice = this.product_id.get_price(
            this.order_id.pricelist_id,
            qty * ratio,
            this.get_price_extra() || 0
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
        this.set_unit_price(this._mubComputeUnitPrice());
    },

    set_quantity(quantity, keep_price) {
        const result = super.set_quantity(...arguments);
        const uom = this.mubUom;
        if (result === true && uom) {
            // Standard rounds with the product UoM: re-round with the line UoM.
            const quant = typeof quantity === "number"
                ? quantity
                : oParseFloat("" + (quantity ? quantity : 0));
            const dp = this.models["decimal.precision"].find(
                (d) => d.name === "Product Unit of Measure"
            );
            const decimals = dp ? dp.digits : 3;
            this.qty = uom.rounding
                ? roundPrecision(quant, Math.max(uom.rounding, Math.pow(10, -decimals)))
                : roundPrecision(quant, 1);
        }
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

    can_be_merged_with(orderline) {
        const uom = this.mubUom;
        const otherUom = orderline.mubUom;
        if ((uom ? uom.id : false) !== (otherUom ? otherUom.id : false)) {
            return false;
        }
        if (!uom) {
            return super.can_be_merged_with(...arguments);
        }
        // Standard compares the line price with the main-UoM product price,
        // which never matches for a secondary UoM: same rules, UoM price.
        const dp = this.models["decimal.precision"].find((d) => d.name === "Product Price");
        const digits = dp ? dp.digits : 2;
        const expected = roundDecimals(orderline._mubComputeUnitPrice(this.get_quantity()), digits);
        const sameNote =
            (!orderline.get_customer_note() && !this.get_customer_note()) ||
            orderline.get_customer_note() === this.get_customer_note();
        return (
            !this.skip_change &&
            orderline.getNote() === this.getNote() &&
            this.get_product().id === orderline.get_product().id &&
            this.is_pos_groupable() &&
            this.get_discount() === 0 &&
            orderline.get_discount() === 0 &&
            !this._mubIsPriceLocked() &&
            !orderline._mubIsPriceLocked() &&
            Math.abs(roundDecimals(this.price_unit || 0, digits) - expected) <
                Math.pow(10, -digits) / 2 &&
            !this.isLotTracked() &&
            this.full_product_name === orderline.full_product_name &&
            sameNote &&
            !orderline.isPartOfCombo()
        );
    },

    /**
     * Switch the line UoM. The quantity number is kept (re-rounded with the
     * new unit) and the price is converted: recomputed from the pricelist,
     * or, for manually priced lines, converted proportionally.
     */
    mubSetUom(uom) {
        this.order_id.assert_editable();
        const main = this.product_id.uom_id;
        const newUom = uom && main && uom.id !== main.id ? uom : false;
        const oldUom = this.mubUom || false;
        if ((newUom ? newUom.id : false) === (oldUom ? oldUom.id : false)) {
            return false;
        }
        const fromUom = oldUom || main;
        const toUom = newUom || main;
        const manualPrice = this.price_type !== "original";
        const oldPrice = this.get_unit_price();

        this.product_uom_id = newUom || main;
        this.set_quantity(this.get_quantity(), true);

        if (manualPrice) {
            // Price per new unit = price per old unit x old units in one new unit.
            this.set_unit_price(oldPrice * ((1 / toUom.factor) * fromUom.factor));
        } else if (newUom) {
            this._mubRecomputePrice();
        } else {
            this.set_unit_price(
                this.product_id.get_price(
                    this.order_id.pricelist_id,
                    this.get_quantity(),
                    this.get_price_extra()
                )
            );
        }
        return true;
    },
});

patch(PosOrder.prototype, {
    set_pricelist(pricelist) {
        const result = super.set_pricelist(...arguments);
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
