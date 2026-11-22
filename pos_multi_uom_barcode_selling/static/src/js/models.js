odoo.define('pos_multi_uom_barcode_selling.models', function (require) {
    'use strict';

    const { PosGlobalState, Order, Orderline } = require('point_of_sale.models');
    const Registries = require('point_of_sale.Registries');
    const core = require('web.core');
    const _t = core._t;

    /**
     * Session-level index, built once from the data loaded at session start.
     * Scans and UoM switches only read these Maps (no RPC per action).
     */
    const MubPosGlobalState = (PosGlobalState) => class MubPosGlobalState extends PosGlobalState {
        async _processData(loadedData) {
            await super._processData(...arguments);
            this._mubBuildIndex(loadedData['product.uom.barcode'] || []);
        }

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
        }

        mubIsEnabled() {
            return Boolean(this.config && this.config.multi_uom_barcode_selling);
        }

        mubFindBarcode(code) {
            if (!code || !this.mubBarcodeIndex) {
                return undefined;
            }
            return this.mubBarcodeIndex.get(code);
        }

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
        }

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
        }
    };
    Registries.Model.extend(PosGlobalState, MubPosGlobalState);

    const MubOrderline = (Orderline) => class MubOrderline extends Orderline {
        constructor() {
            super(...arguments);
            if (this.mub_uom_id === undefined) {
                this.mub_uom_id = false;
            }
        }

        init_from_JSON(json) {
            // Set before super so quantity rounding uses the line UoM.
            this.mub_uom_id = json.product_uom_id || false;
            super.init_from_JSON(...arguments);
            const mainId = this.product && this.product.uom_id && this.product.uom_id[0];
            if (!this.mub_uom_id || this.mub_uom_id === mainId || !this.pos.units_by_id[this.mub_uom_id]) {
                this.mub_uom_id = false;
            }
        }

        export_as_JSON() {
            const json = super.export_as_JSON(...arguments);
            const mainId = this.product && this.product.uom_id ? this.product.uom_id[0] : false;
            json.product_uom_id = this.mub_uom_id || mainId;
            return json;
        }

        export_for_printing() {
            const json = super.export_for_printing(...arguments);
            const unit = this.mub_uom_id ? this.get_unit() : undefined;
            if (unit) {
                json.mub_uom_name = unit.name;
                if (Array.isArray(json.product_name_wrapped)) {
                    // Rendered by WrappedProductNameLines under the product name.
                    json.product_name_wrapped = [
                        ...json.product_name_wrapped,
                        _t('Unit of Measure') + ': ' + unit.name,
                    ];
                }
            }
            return json;
        }

        clone() {
            const orderline = super.clone(...arguments);
            orderline.mub_uom_id = this.mub_uom_id;
            return orderline;
        }

        get_unit() {
            if (this.mub_uom_id && this.pos && this.pos.units_by_id) {
                const unit = this.pos.units_by_id[this.mub_uom_id];
                if (unit) {
                    return unit;
                }
            }
            return super.get_unit(...arguments);
        }

        _mubMainUomId() {
            return this.product && this.product.uom_id ? this.product.uom_id[0] : false;
        }

        /** Main-UoM quantity represented by one unit of the line UoM. */
        get_mub_ratio() {
            if (!this.mub_uom_id) {
                return 1;
            }
            return this.pos.mubConvertQty(1, this.mub_uom_id, this._mubMainUomId());
        }

        /** Line quantity expressed in the product's main UoM. */
        get_mub_base_quantity() {
            return this.get_quantity() * this.get_mub_ratio();
        }

        _mubPriceExtra() {
            return typeof this.get_price_extra === 'function' ? this.get_price_extra() || 0 : 0;
        }

        /**
         * The pricelist is evaluated on the main-UoM quantity (min_quantity keeps
         * its meaning) and the main-UoM price is converted to the line UoM:
         * 1 GM = 1 USD  =>  1 KG = 1000 USD.
         */
        _mubComputeUnitPrice(quantity) {
            const ratio = this.get_mub_ratio();
            const qty = quantity === undefined ? this.get_quantity() : quantity;
            const basePrice = this.product.get_price(
                this.order.pricelist, qty * ratio, this._mubPriceExtra());
            return basePrice * ratio;
        }

        _mubCustomerNote() {
            return (typeof this.get_customer_note === 'function' ? this.get_customer_note() : '') || '';
        }

        /** Lines whose price must never be recomputed from the pricelist. */
        _mubIsPriceLocked() {
            return Boolean(
                this.price_manually_set
                || this.price_automatically_set   // refund lines keep the price paid
                || this.refunded_orderline_id
                || this.is_reward_line
            );
        }

        _mubRecomputePrice() {
            if (!this.mub_uom_id || !this.order || this._mubIsPriceLocked()) {
                return;
            }
            this.set_unit_price(this._mubComputeUnitPrice());
            this.order.fix_tax_included_price(this);
        }

        set_quantity(quantity, keep_price) {
            const result = super.set_quantity(...arguments);
            if (this.mub_uom_id && !keep_price && quantity !== 'remove' && result !== false) {
                this._mubRecomputePrice();
            }
            return result;
        }

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
            const product = this.get_product();
            const unit = this.get_unit();
            const pickingType = this.pos.picking_type || {};
            if (product.id !== orderline.get_product().id
                    || !unit || !unit.is_pos_groupable
                    || this.get_discount() > 0 || orderline.get_discount() > 0
                    || this._mubIsPriceLocked() || orderline._mubIsPriceLocked()
                    || (this.description || '') !== (orderline.description || '')
                    || this._mubCustomerNote() !== orderline._mubCustomerNote()
                    || (product.tracking === 'lot'
                        && (pickingType.use_create_lots || pickingType.use_existing_lots))) {
                return false;
            }
            const expected = orderline._mubComputeUnitPrice(this.get_quantity());
            const decimals = this.pos.dp['Product Price'];
            return Math.abs(this.get_unit_price() - expected) < Math.pow(10, -decimals) / 2;
        }

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
            const manualPrice = this.price_manually_set;
            const oldPrice = this.get_unit_price();

            this.mub_uom_id = newId;
            this.set_quantity(this.get_quantity(), true);

            if (manualPrice) {
                this.set_unit_price(oldPrice * this.pos.mubConvertQty(1, newUnitId, oldUnitId));
            } else if (newId) {
                this._mubRecomputePrice();
            } else {
                this.set_unit_price(this.product.get_price(
                    this.order.pricelist, this.get_quantity(), this._mubPriceExtra()));
                this.order.fix_tax_included_price(this);
            }
            return true;
        }
    };
    Registries.Model.extend(Orderline, MubOrderline);

    const MubOrder = (Order) => class MubOrder extends Order {
        set_orderline_options(orderline, options) {
            const uomId = options && options.extras && options.extras.mub_uom_id;
            if (uomId) {
                // Before super so the quantity and price use the UoM.
                orderline.mub_uom_id = uomId;
            }
            super.set_orderline_options(...arguments);
            if (uomId && options.price === undefined && !orderline.price_manually_set) {
                orderline._mubRecomputePrice();
            }
        }

        set_pricelist(pricelist) {
            super.set_pricelist(...arguments);
            const lines = this.orderlines ? this.get_orderlines() : [];
            for (const line of lines) {
                if (line.mub_uom_id && !line.price_manually_set) {
                    line._mubRecomputePrice();
                }
            }
        }
    };
    Registries.Model.extend(Order, MubOrder);

    return { MubPosGlobalState, MubOrderline, MubOrder };
});
