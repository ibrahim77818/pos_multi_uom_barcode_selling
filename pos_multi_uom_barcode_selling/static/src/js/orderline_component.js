import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { patch } from "@web/core/utils/patch";

/** Same component renders the order lines on screen and on the receipt. */
patch(Orderline.prototype, {
    get lineScreenValues() {
        const vals = super.lineScreenValues;
        const line = this.line;
        const uom = line && line.order_id && line.mubUom;
        if (uom) {
            vals.mubUomName = uom.name;
            if (vals.displayPriceUnit) {
                // Standard prints "price / <product unit>": use the line unit.
                vals.displayPriceUnit = line.currencyDisplayPriceUnit + " / " + uom.name;
            }
        }
        return vals;
    },
});
