import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";

/**
 * Loyalty rules count quantities in the product's main UoM (a rule
 * "minimum 500 g" must accept 1 KG). While points are computed, lines sold
 * in a secondary UoM expose their main-UoM quantity. Odoo 19 computes the
 * line amounts (line.prices) from the order, not from getQuantity(), so
 * money-based rules keep the real line totals.
 * pointsForPrograms is synchronous, so the shadowing never leaks.
 */
patch(PosOrder.prototype, {
    pointsForPrograms(programs) {
        const patched = [];
        for (const line of this.getOrderlines()) {
            if (!line.mubUom || line.is_reward_line) {
                continue;
            }
            const baseQty = line.get_mub_base_quantity();
            line.getQuantity = () => baseQty;
            patched.push(line);
        }
        try {
            return super.pointsForPrograms(...arguments);
        } finally {
            for (const line of patched) {
                delete line.getQuantity;
            }
        }
    },
});
