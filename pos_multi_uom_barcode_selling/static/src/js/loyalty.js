/** @odoo-module */

import { Order } from "@point_of_sale/app/store/models";
import { patch } from "@web/core/utils/patch";

/**
 * Loyalty rules count quantities in the product's main UoM (a rule
 * "minimum 500 g" must accept 1 KG). While points are computed, lines sold
 * in a secondary UoM expose their main-UoM quantity; their amounts are
 * frozen first so money-based rules keep the real line totals.
 * pointsForPrograms is synchronous, so the shadowing never leaks.
 */
patch(Order.prototype, {
    pointsForPrograms(programs) {
        const patched = [];
        for (const line of this.get_orderlines()) {
            if (!line.mub_uom_id || line.is_reward_line) {
                continue;
            }
            const baseQty = line.get_mub_base_quantity();
            const priceWithTax = line.get_price_with_tax();
            const priceWithoutTax = line.get_price_without_tax();
            line.get_quantity = () => baseQty;
            line.get_price_with_tax = () => priceWithTax;
            line.get_price_without_tax = () => priceWithoutTax;
            patched.push(line);
        }
        try {
            return super.pointsForPrograms(...arguments);
        } finally {
            for (const line of patched) {
                delete line.get_quantity;
                delete line.get_price_with_tax;
                delete line.get_price_without_tax;
            }
        }
    },
});
