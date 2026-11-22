# -*- coding: utf-8 -*-
import math

from odoo import models


class LoyaltyRule(models.Model):
    _inherit = 'loyalty.rule'

    # Odoo 20 also evaluates POS loyalty on the server (promotions and points
    # credited to cards). Quantities of lines sold in a secondary UoM count in
    # the product's main UoM, as in the POS (static/src/js/loyalty.js):
    # 1 KG satisfies "minimum 500 g".
    # Standard code is never copied: it is called as is, with the minimum
    # quantity translated so that the standard (line UoM) comparison gives the
    # main-UoM answer. This keeps the override independent of internal helpers
    # that change between Odoo 20 builds.

    def _mub_qualifying_lines(self, order, lines=None):
        if getattr(order, '_name', None) != 'pos.order' or not hasattr(self, '_qualifying_lines'):
            return None
        qualifying = self._qualifying_lines(order, lines)
        if not any(line._mub_is_secondary_uom() for line in qualifying):
            return None
        return qualifying

    def _is_fulfilled(self, order, lines=None):
        qualifying = self._mub_qualifying_lines(order, lines) if len(self) == 1 else None
        if qualifying is None:
            return super()._is_fulfilled(order, lines)
        main_qty = sum(line._mub_get_product_uom_qty() for line in qualifying)
        line_qty = sum(qualifying.mapped('qty'))
        if main_qty >= self.minimum_qty:
            minimum_qty = 0
        else:
            # Any value above the line quantities makes the standard check fail.
            minimum_qty = max(math.floor(line_qty) + 1, 1)
        # A virtual copy of the rule (not saved) with the translated minimum.
        virtual = self.new({'minimum_qty': minimum_qty}, origin=self)
        return super(LoyaltyRule, virtual)._is_fulfilled(order, lines)

    def _get_pos_order_points(self, order, lines=None):
        points = super()._get_pos_order_points(order, lines)
        if not points or len(self) != 1 or self.reward_point_mode != 'unit':
            return points
        qualifying = self._mub_qualifying_lines(order, lines)
        if qualifying is None:
            return points
        # Standard: reward_point_amount x quantities in the line UoM.
        return self.reward_point_amount * sum(line._mub_get_product_uom_qty() for line in qualifying)
