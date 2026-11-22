import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { useBarcodeReader } from "@point_of_sale/app/hooks/barcode_reader_hook";
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
        this.sound.play("scan-error");
        this.barcodeReader.showNotFoundNotification(code);
    },

    async _mubAddScannedUomProduct(match, code) {
        let product = this.pos.models["product.product"].get(match.productId);
        if (!product) {
            // Only when the product has not been loaded yet (limited loading).
            await this.pos.loadNewProducts([["product_variant_ids", "in", [match.productId]]]);
            product = this.pos.models["product.product"].get(match.productId);
        }
        const uom = this.pos.models["uom.uom"].get(match.uomId);
        if (!product || !uom) {
            this.sound.play("scan-error");
            this.barcodeReader.showNotFoundNotification(code);
            return;
        }
        this.sound.play("beep");
        // The UoM barcode already defines the quantity (1 unit of that UoM):
        // skip the weighing scale while still asking for variants and lots.
        const template = product.product_tmpl_id;
        const toWeight = template.to_weight;
        template.to_weight = false;
        let line;
        try {
            line = await this.pos.addLineToCurrentOrder(
                { product_id: product, product_tmpl_id: template, product_uom_id: uom, qty: 1 },
                { code },
                product.needToConfigure()
            );
        } finally {
            template.to_weight = toWeight;
        }
        // Lot-tracked products are re-priced by standard after the merge.
        const order = this.pos.getOrder();
        if (order) {
            order._mubRecomputeProductLines(product);
        }
        this.numberBuffer.reset();
        if (line) {
            this.showOptionalProductPopupIfNeeded(product);
        }
    },
});
