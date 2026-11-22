import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { useBarcodeReader } from "@point_of_sale/app/barcode/barcode_reader_hook";
import { patch } from "@web/core/utils/patch";

patch(ProductScreen.prototype, {
    setup() {
        super.setup(...arguments);
        // Nomenclatures without a catch-all product rule report unknown codes
        // as "error": catch those too, before the standard "not found" notice.
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
        // Registering an "error" callback disables the service's own notice.
        this.sound.play("error");
        this.barcodeReader.showNotFoundNotification(code);
    },

    async _mubAddScannedUomProduct(match, code) {
        let product = this.pos.models["product.product"].get(match.productId);
        if (!product) {
            // Only when "Limited Product Loading" has not loaded the product yet:
            // the server resolves UoM barcodes in find_product_by_barcode.
            product = await this._getProductByBarcode(code);
        }
        const uom = this.pos.models["uom.uom"].get(match.uomId);
        if (!product || !uom) {
            this.sound.play("error");
            this.barcodeReader.showNotFoundNotification(code);
            return;
        }
        // The UoM barcode already defines the quantity (1 unit of that UoM):
        // skip the weighing scale while still asking for variants and lots.
        const toWeight = product.to_weight;
        product.to_weight = false;
        try {
            await this.pos.addLineToCurrentOrder(
                { product_id: product, product_uom_id: uom, qty: 1 },
                { code },
                product.needToConfigure()
            );
        } finally {
            product.to_weight = toWeight;
        }
        this.numberBuffer.reset();
    },
});
