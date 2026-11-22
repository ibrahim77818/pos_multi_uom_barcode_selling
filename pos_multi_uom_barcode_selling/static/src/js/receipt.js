import { GeneratePrinterData } from "@point_of_sale/app/utils/printer/generate_printer_data";
import { patch } from "@web/core/utils/patch";

/**
 * Odoo 20 receipts are built from line data. Mirror of
 * models/pos_order_receipt.py: lines sold in a secondary UoM show that unit.
 */
patch(GeneratePrinterData.prototype, {
    generateLineData() {
        return super.generateLineData().map((data, index) => {
            const line = this.order.lines[index];
            const uom = line && line.mubUom;
            data.mub_uom_name = false;
            if (uom) {
                data.product_uom_name = uom.name;
                data.mub_uom_name = uom.name;
            }
            return data;
        });
    },
});
