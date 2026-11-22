/** @odoo-module */

import { PosStore } from "@point_of_sale/app/store/pos_store";
import { Order, Orderline } from "@point_of_sale/app/store/models";
import { patch } from "@web/core/utils/patch";
import { roundDecimals } from "@web/core/utils/numbers";

// NOTE: no template literals in this module: Odoo's JS minifier can strip
// spaces inside them (seen in v16: "g(main unit)").

/**
 * Session-level index, built once from the data loaded at session start.
 * Scans and UoM switches only read these Maps (no RPC per action).
 */
patch(PosStore.prototype, {
    async _processData(loadedData) {
        await super._processData(...arguments);
        this._mubBuildIndex(loadedData["product.uom.barcode"] || []);
    },

    _mubBuildIndex(records) {
        this.mubBarcodeIndex = new Map();
        this.mubUomIdsByProduct = new Map();
        if (!this.config.multi_uom_barcode_selling) {
            return;
        }
        for (const record of records) {
            const productId = record.product_id && record.product_id[0];
            const uomId = record.uom_id && record.uom_id[0];
            if (!record.barcode || !productId || !uomId || !this.units_by_id[uomId]) {
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
        const mainId = product.uom_id && product.uom_id[0];
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
    mubConvertQty(qty, fromUomId, toUomId) {
        if (!fromUomId || !toUomId || fromUomId === toUomId) {
            return qty;
        }
        const from = this.units_by_id[fromUomId];
        const to = this.units_by_id[toUomId];
        if (!from || !to || !from.factor || !to.factor) {
            return qty;
        }
        return (qty / from.factor) * to.factor;
    },
});

patch(Orderline.prototype, {
    setup(_defaultObj, options) {
        super.setup(...arguments);
        if (this.mub_uom_id === undefined) {
            this.mub_uom_id = false;
        }
    },

    init_from_JSON(json) {
        // Set before super so quantity rounding uses the line UoM.
        this.mub_uom_id = json.product_uom_id || false;
        super.init_from_JSON(...arguments);
        const mainId = this._mubMainUomId();
        if (!this.mub_uom_id || this.mub_uom_id === mainId || !this.pos.units_by_id[this.mub_uom_id]) {
            this.mub_uom_id = false;
        }
    },

    export_as_JSON() {
        const json = super.export_as_JSON(...arguments);
        json.product_uom_id = this.mub_uom_id || this._mubMainUomId();
        return json;
    },

    getDisplayData() {
        const data = super.getDisplayData(...arguments);
        // Rendered as a badge by the Orderline component (screen and receipt).
        data.mubUomName = this.mub_uom_id ? this.get_unit().name : false;
        return data;
    },

    clone() {
        const orderline = super.clone(...arguments);
        orderline.mub_uom_id = this.mub_uom_id;
        return orderline;
    },

    get_unit() {
        if (this.mub_uom_id && this.pos && this.pos.units_by_id) {
            const unit = this.pos.units_by_id[this.mub_uom_id];
            if (unit) {
                return unit;
            }
        }
        return super.get_unit(...arguments);
    },

    _mubMainUomId() {
        return this.product && this.product.uom_id ? this.product.uom_id[0] : false;
    },

    /** Main-UoM quantity represented by one unit of the line UoM. */
    get_mub_ratio() {
        if (!this.mub_uom_id) {
            return 1;
        }
        return this.pos.mubConvertQty(1, this.mub_uom_id, this._mubMainUomId());
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
        const basePrice = this.product.get_price(
            this.order.pricelist,
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
                this.comboParent ||
                (this.comboLines && this.comboLines.length)
        );
    },

    _mubRecomputePrice() {
        if (!this.mub_uom_id || !this.order || this._mubIsPriceLocked()) {
            return;
        }
        this.set_unit_price(this._mubComputeUnitPrice());
        this.order.fix_tax_included_price(this);
    },

    set_quantity(quantity, keep_price) {
        const result = super.set_quantity(...arguments);
        if (!keep_price && result !== false && this.order) {
            // Standard re-prices this line (and, for lot-tracked products, every
            // line of the product) with the main-UoM price: restore UoM prices.
            this.order._mubRecomputeProductLines(this.product);
        }
        return result;
    },

    can_be_merged_with(orderline) {
        const uomId = this.mub_uom_id || false;
        if (uomId !== (orderline.mub_uom_id || false)) {
            return false;
        }
        if (!uomId) {
            return super.can_be_merged_with(...arguments);
        }
        // Standard compares the line price with the main-UoM product price,
        // which never matches for a secondary UoM: same rules, UoM price.
        const sameAttributes =
            JSON.stringify(this.attribute_value_ids || []) ===
            JSON.stringify(orderline.attribute_value_ids || []);
        const digits = this.pos.dp["Product Price"];
        const expected = roundDecimals(orderline._mubComputeUnitPrice(this.get_quantity()), digits);
        return (
            !this.skipChange &&
            orderline.getNote() === this.getNote() &&
            this.get_product().id === orderline.get_product().id &&
            Boolean(this.get_unit()) &&
            this.is_pos_groupable() &&
            this.get_discount() === 0 &&
            orderline.get_discount() === 0 &&
            !this._mubIsPriceLocked() &&
            !orderline._mubIsPriceLocked() &&
            Math.abs(this.get_unit_price() - expected) < Math.pow(10, -digits) / 2 &&
            !this.is_lot_tracked() &&
            this.full_product_name === orderline.full_product_name &&
            orderline.get_customer_note() === this.get_customer_note() &&
            !this.isPartOfCombo() &&
            !orderline.isPartOfCombo() &&
            sameAttributes
        );
    },

    /**
     * Switch the line UoM. The quantity number is kept (re-rounded with the
     * new unit) and the price is converted: recomputed from the pricelist,
     * or, for manually priced lines, converted proportionally.
     */
    mubSetUom(uomId) {
        this.order.assert_editable();
        const mainId = this._mubMainUomId();
        const newId = uomId && uomId !== mainId ? uomId : false;
        const oldId = this.mub_uom_id || false;
        if (newId === oldId) {
            return false;
        }
        const oldUnitId = oldId || mainId;
        const newUnitId = newId || mainId;
        const manualPrice = this.price_type !== "original";
        const oldPrice = this.get_unit_price();

        this.mub_uom_id = newId;
        this.set_quantity(this.get_quantity(), true);

        if (manualPrice) {
            this.set_unit_price(oldPrice * this.pos.mubConvertQty(1, newUnitId, oldUnitId));
        } else if (newId) {
            this._mubRecomputePrice();
        } else {
            this.set_unit_price(
                this.product.get_price(this.order.pricelist, this.get_quantity(), this.get_price_extra())
            );
            this.order.fix_tax_included_price(this);
        }
        return true;
    },
});

patch(Order.prototype, {
    set_orderline_options(orderline, options) {
        const uomId = options && options.extras && options.extras.mub_uom_id;
        if (uomId) {
            // Before super so the quantity and price use the UoM.
            orderline.mub_uom_id = uomId;
        }
        super.set_orderline_options(...arguments);
        if (uomId && options.price === undefined) {
            orderline._mubRecomputePrice();
        }
    },

    async add_product(product, options) {
        const line = await super.add_product(...arguments);
        // Lot-tracked products are re-priced by standard after the options.
        if (product) {
            this._mubRecomputeProductLines(product);
        }
        return line;
    },

    set_pricelist(pricelist) {
        super.set_pricelist(...arguments);
        for (const line of this.orderlines || []) {
            if (line.mub_uom_id) {
                line._mubRecomputePrice();
            }
        }
    },

    _mubRecomputeProductLines(product) {
        for (const line of this.orderlines || []) {
            if (line.mub_uom_id && line.product && line.product.id === product.id) {
                line._mubRecomputePrice();
            }
        }
    },
});
