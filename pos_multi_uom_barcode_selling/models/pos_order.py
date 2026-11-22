# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools.sql import column_exists, create_column


class PosOrderLine(models.Model):
    _inherit = 'pos.order.line'

    # In standard Odoo 16 this field is related to the product UoM (not stored).
    # It becomes the UoM the line was actually sold in.
    product_uom_id = fields.Many2one(
        'uom.uom', string='Product UoM', related=False,
        compute='_compute_product_uom_id', store=True, readonly=False, precompute=True,
    )

    def _auto_init(self):
        # Fill the new column with SQL on install instead of an ORM recompute
        # over every historical POS order line.
        cr = self.env.cr
        if not column_exists(cr, 'pos_order_line', 'product_uom_id'):
            create_column(cr, 'pos_order_line', 'product_uom_id', 'int4')
            cr.execute("""
                UPDATE pos_order_line line
                   SET product_uom_id = tmpl.uom_id
                  FROM product_product prod
                  JOIN product_template tmpl ON tmpl.id = prod.product_tmpl_id
                 WHERE prod.id = line.product_id
            """)
        return super()._auto_init()

    @api.depends('product_id')
    def _compute_product_uom_id(self):
        for line in self:
            product_uom = line.product_id.uom_id
            if line.product_uom_id and product_uom \
                    and line.product_uom_id.category_id == product_uom.category_id:
                line.product_uom_id = line.product_uom_id
            else:
                line.product_uom_id = product_uom

    @api.constrains('product_uom_id', 'product_id')
    def _check_product_uom_category(self):
        for line in self:
            if line.product_uom_id and line.product_id \
                    and line.product_uom_id.category_id != line.product_id.uom_id.category_id:
                raise ValidationError(_(
                    'The unit of measure %(uom)s of the order line %(product)s must belong to the '
                    'category of the product unit of measure (%(category)s).',
                    uom=line.product_uom_id.name, product=line.product_id.display_name,
                    category=line.product_id.uom_id.category_id.name,
                ))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _mub_is_secondary_uom(self):
        self.ensure_one()
        return bool(self.product_uom_id) and self.product_uom_id != self.product_id.uom_id

    def _mub_get_product_uom_qty(self):
        """Quantity of the line expressed in the product's main UoM."""
        self.ensure_one()
        if not self._mub_is_secondary_uom():
            return self.qty
        return self.product_uom_id._compute_quantity(self.qty, self.product_id.uom_id, round=False)

    # ------------------------------------------------------------------
    # POS synchronisation
    # ------------------------------------------------------------------
    @api.model
    def _order_line_fields(self, line, session_id=None):
        line = super()._order_line_fields(line, session_id=session_id)
        vals = line[2] if line and len(line) > 2 and isinstance(line[2], dict) else None
        if vals and vals.get('product_uom_id'):
            product = self.env['product.product'].browse(vals.get('product_id')).exists()
            uom = self.env['uom.uom'].browse(vals['product_uom_id']).exists()
            # Never block the synchronisation of a paid order: fall back to the
            # product UoM when the POS sends an unusable unit.
            if not product or not uom or uom.category_id != product.uom_id.category_id:
                vals['product_uom_id'] = product.uom_id.id if product else False
        return line

    def _export_for_ui(self, orderline):
        result = super()._export_for_ui(orderline)
        result['product_uom_id'] = orderline.product_uom_id.id or orderline.product_id.uom_id.id
        return result

    # ------------------------------------------------------------------
    # Costs (margin) - the cost is per main UoM, the quantity may not be
    # ------------------------------------------------------------------
    def _mub_moves_for_cost(self, stock_moves):
        self.ensure_one()
        if hasattr(self, '_get_stock_moves_to_consider'):
            return self._get_stock_moves_to_consider(stock_moves, self.product_id)
        return stock_moves.filtered(lambda move: move.product_id == self.product_id)

    def _compute_total_cost(self, stock_moves):
        mub_lines = self.filtered(
            lambda line: not line.is_total_cost_computed and line._mub_is_secondary_uom())
        for line in mub_lines:
            product = line.product_id
            qty = line._mub_get_product_uom_qty()
            moves = line._mub_moves_for_cost(stock_moves) if stock_moves else stock_moves
            if moves and product.type == 'product' and product.cost_method in ('fifo', 'average'):
                product_cost = product._compute_average_price(0, qty, moves)
            else:
                product_cost = product.standard_price
            line.total_cost = qty * product.sudo().cost_currency_id._convert(
                from_amount=product_cost,
                to_currency=line.currency_id,
                company=line.company_id or self.env.company,
                date=line.order_id.date_order or fields.Date.today(),
                round=False,
            )
            line.is_total_cost_computed = True
        return super(PosOrderLine, self - mub_lines)._compute_total_cost(stock_moves)
