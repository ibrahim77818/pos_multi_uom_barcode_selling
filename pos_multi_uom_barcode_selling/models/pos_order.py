# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError
from odoo.tools.sql import column_exists, create_column


class PosOrderLine(models.Model):
    _inherit = 'pos.order.line'

    # In standard Odoo this field is related to the product UoM (not stored).
    # It becomes the UoM the line was actually sold in.
    # Odoo 18's POS does not send computed, related or local fields when it
    # saves an order, so this must be a plain stored field: create()/write()
    # fill it with the product UoM when the POS sends none.
    product_uom_id = fields.Many2one('uom.uom', string='Product UoM', related=False)

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

    @api.model
    def _load_pos_data_fields(self, config):
        # The POS stores the sold unit natively on the line record.
        fields = super()._load_pos_data_fields(config)
        return fields + ['product_uom_id'] if 'product_uom_id' not in fields else fields

    @api.model
    def _mub_sanitize_uom_vals(self, vals, product=None):
        """Fill a missing unit with the product unit; an unusable unit sent by
        the POS falls back to the product unit (never block the sync of a paid
        order)."""
        product = product or self.env['product.product'].browse(vals.get('product_id')).exists()
        if not product:
            return vals
        uom = self.env['uom.uom'].browse(vals['product_uom_id']).exists() if vals.get('product_uom_id') else None
        if not uom or not uom._has_common_reference(product.uom_id):
            vals['product_uom_id'] = product.uom_id.id
        return vals

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('product_id'):
                self._mub_sanitize_uom_vals(vals)
        return super().create(vals_list)

    def write(self, vals):
        if 'product_id' in vals and 'product_uom_id' not in vals:
            # Changing the product keeps a compatible unit, else the new product unit.
            product = self.env['product.product'].browse(vals['product_id']).exists()
            for line in self:
                line_vals = dict(vals, product_uom_id=line.product_uom_id.id)
                super(PosOrderLine, line).write(self._mub_sanitize_uom_vals(line_vals, product))
            return True
        return super().write(vals)

    @api.constrains('product_uom_id', 'product_id')
    def _check_product_uom_category(self):
        for line in self:
            if line.product_uom_id and line.product_id \
                    and not line.product_uom_id._has_common_reference(line.product_id.uom_id):
                raise ValidationError(_(
                    'The unit of measure %(uom)s of the order line %(product)s cannot be converted '
                    'to the product unit of measure (%(main_uom)s).',
                    uom=line.product_uom_id.name, product=line.product_id.display_name,
                    main_uom=line.product_id.uom_id.name,
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
    # Costs (margin). Odoo 20: total_cost = qty x _get_product_cost(), and
    # the product cost is per main UoM while qty is in the line UoM.
    # ------------------------------------------------------------------
    def _get_product_cost(self, at_closing=False):
        cost = super()._get_product_cost(at_closing)
        if not self._mub_is_secondary_uom():
            return cost
        refunded = self.refunded_orderline_id
        if refunded and refunded.qty and refunded.product_uom_id == self.product_uom_id \
                and self.product_id.sudo().cost_currency_id.is_zero(
                    cost - refunded.total_cost / refunded.qty):
            # Standard fallback for refunds: already a cost per line UoM.
            return cost
        return cost * self.product_uom_id._compute_quantity(1.0, self.product_id.uom_id, round=False)

    # ------------------------------------------------------------------
    # Ship later: Odoo 20 launches procurements in the product's main UoM
    # with the quantity returned by _get_qty_to_move(); convert it.
    # ------------------------------------------------------------------
    def _get_qty_to_move(self):
        qty = super()._get_qty_to_move()
        if self.env.context.get('mub_qty_in_product_uom') and self._mub_is_secondary_uom():
            return self.product_uom_id._compute_quantity(qty, self.product_id.uom_id, round=False)
        return qty

    def _launch_stock_rule_from_pos_order_lines(self):
        return super(PosOrderLine, self.with_context(mub_qty_in_product_uom=True)) \
            ._launch_stock_rule_from_pos_order_lines()
