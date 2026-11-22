import { LoyaltyRule } from "@pos_loyalty/app/models/loyalty_rule";
import { PosOrderline } from "@point_of_sale/app/models/pos_order_line";
import { patch } from "@web/core/utils/patch";

/**
 * Loyalty rules count quantities in the product's main UoM (a rule
 * "minimum 500 g" must accept 1 KG). Odoo 20 evaluates rules in
 * LoyaltyRule.isFulfilled / getPoints, often while the screen renders.
 * Nothing is written on the (reactive) order lines: a plain module variable
 * tells getQuantity() to answer in the main UoM while a rule is evaluated,
 * so no re-render is triggered. Line amounts come from line.qty, so amount
 * and money rules keep the real totals. Server mirror: models/loyalty_rule.py.
 */
let mubLoyaltyDepth = 0;

function mubInMainUom(callback) {
    mubLoyaltyDepth++;
    try {
        return callback();
    } finally {
        mubLoyaltyDepth--;
    }
}

patch(PosOrderline.prototype, {
    getQuantity() {
        const qty = super.getQuantity(...arguments);
        if (mubLoyaltyDepth > 0 && this.mubUom && !this.is_reward_line) {
            return qty * this.get_mub_ratio();
        }
        return qty;
    },
});

patch(LoyaltyRule.prototype, {
    isFulfilled(order) {
        return mubInMainUom(() => super.isFulfilled(...arguments));
    },
    getPoints(order) {
        return mubInMainUom(() => super.getPoints(...arguments));
    },
});
