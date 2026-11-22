/** @odoo-module */

import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { useBarcodeReader } from "@point_of_sale/app/barcode/barcode_reader_hook";
import { ErrorBarcodePopup } from "@point_of_sale/app/barcode/error_popup/barcode_error_popup";
import { patch } from "@web/core/utils/patch";

patch(ProductScreen.prototype, {
    setup() {
        super.setup(...arguments);
        // Nomenclatures without a catch-all product rule report unknown codes
        // as "error": catch those too, before the standard error popup.
        useBarcodeReader({ error: this._mubBarcodeErrorAction });
    },

    _mubMatch(code) {
        if (!code || !this.pos.mubIsEnabled || !this.pos.mubIsEnabled()) {
            return undefined;
        }
        return this.pos.mubFindBarcode(code.base_code) || this.pos.mubFindBarcode(code.code);
    },

    async _barcodeProductAction(code) {
        const match = this._mubMatch(code);
        if (match) {
            return this._mubAddScannedUomProduct(match, code);
        }
        return super._barcodeProductAction(...arguments);
    },

    async _mubBarcodeErrorAction(code) {
        const match = this._mubMatch(code);
        if (match) {
            return this._mubAddScannedUomProduct(match, code);
        }
        // Registering an "error" callback disables the service's own popup.
        return this.popup.add(ErrorBarcodePopup, { code: code.code });
    },

    async _mubAddScannedUomProduct(match, code) {
        let product = this.pos.db.get_product_by_id(match.productId);
        if (!product) {
            // Only when "Limited Product Loading" has not loaded the product yet.
            await this.pos._addProducts([match.productId], false);
            product = this.pos.db.get_product_by_id(match.productId);
        }
        if (!product) {
            return this.popup.add(ErrorBarcodePopup, { code: code.code });
        }
        // The UoM barcode already defines the quantity (1 unit of that UoM):
        // skip the weighing scale while still asking for variants and lots.
        const toWeight = product.to_weight;
        product.to_weight = false;
        let options;
        try {
            options = await product.getAddProductOptions(code);
        } finally {
            product.to_weight = toWeight;
        }
        if (!options) {
            return;
        }
        const extras = Object.assign({}, options.extras || {}, { mub_uom_id: match.uomId });
        await this.currentOrder.add_product(
            product,
            Object.assign({}, options, { quantity: 1, extras })
        );
        this.numberBuffer.reset();
    },
});
