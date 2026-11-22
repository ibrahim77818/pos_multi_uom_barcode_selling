odoo.define('pos_multi_uom_barcode_selling.ProductScreen', function (require) {
    'use strict';

    const ProductScreen = require('point_of_sale.ProductScreen');
    const Registries = require('point_of_sale.Registries');
    const NumberBuffer = require('point_of_sale.NumberBuffer');

    const MubProductScreen = (ProductScreen) => class MubProductScreen extends ProductScreen {
        _mubMatch(code) {
            const pos = this.env.pos;
            if (!code || !pos.mubIsEnabled || !pos.mubIsEnabled()) {
                return undefined;
            }
            return pos.mubFindBarcode(code.base_code) || pos.mubFindBarcode(code.code);
        }

        async _barcodeProductAction(code) {
            const match = this._mubMatch(code);
            if (match) {
                return this._mubAddScannedUomProduct(match, code);
            }
            return super._barcodeProductAction(...arguments);
        }

        // Nomenclatures without a catch-all product rule report unknown codes as errors.
        async _barcodeErrorAction(code) {
            const match = this._mubMatch(code);
            if (match) {
                return this._mubAddScannedUomProduct(match, code);
            }
            return super._barcodeErrorAction(...arguments);
        }

        async _mubAddScannedUomProduct(match, code) {
            const pos = this.env.pos;
            let product = pos.db.get_product_by_id(match.productId);
            if (!product && typeof pos._addProducts === 'function') {
                // Only when "Limited Product Loading" has not loaded the product yet.
                await pos._addProducts([match.productId], false);
                product = pos.db.get_product_by_id(match.productId);
            }
            if (!product) {
                return super._barcodeErrorAction(code);
            }
            // The UoM barcode already defines the quantity (1 unit of that UoM):
            // skip the weighing scale while still asking for variants and lots.
            const toWeight = product.to_weight;
            product.to_weight = false;
            let options;
            try {
                options = await this._getAddProductOptions(product, code);
            } finally {
                product.to_weight = toWeight;
            }
            if (!options) {
                return;
            }
            const extras = Object.assign({}, options.extras || {}, { mub_uom_id: match.uomId });
            this.currentOrder.add_product(product, Object.assign({}, options, { quantity: 1, extras }));
            NumberBuffer.reset();
        }
    };
    Registries.Component.extend(ProductScreen, MubProductScreen);

    return MubProductScreen;
});
