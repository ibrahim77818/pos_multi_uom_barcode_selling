# -*- coding: utf-8 -*-
from odoo import models


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    def _prepare_stock_move_vals(self, first_line, order_lines):
        vals = super()._prepare_stock_move_vals(first_line, order_lines)
        uom = first_line.product_uom_id
        if uom and uom != first_line.product_id.uom_id \
                and all(line.product_uom_id == uom for line in order_lines):
            # Quantities are summed in the line UoM, so the move keeps that UoM;
            # product_qty (main UoM) and valuation are converted by stock.move.
            vals['uom_id'] = uom.id
        return vals

    def _create_move_from_pos_order_lines(self, lines):
        """Standard POS groups lines by product only. Lines sold in a secondary
        UoM are processed in separate (product, UoM) batches so that each stock
        move and its move lines carry the UoM of the POS order lines, and lot
        quantities stay expressed in that same UoM."""
        self.ensure_one()
        mub_lines = lines.filtered(
            lambda line: line.product_uom_id and line.product_uom_id != line.product_id.uom_id)
        if not mub_lines:
            return super()._create_move_from_pos_order_lines(lines)
        result = None
        base_lines = lines - mub_lines
        if base_lines:
            result = super()._create_move_from_pos_order_lines(base_lines)
        for uom in mub_lines.product_uom_id:
            super()._create_move_from_pos_order_lines(
                mub_lines.filtered(lambda line, uom=uom: line.product_uom_id == uom))
        return result
