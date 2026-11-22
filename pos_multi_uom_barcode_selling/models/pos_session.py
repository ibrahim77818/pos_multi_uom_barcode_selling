# -*- coding: utf-8 -*-
from odoo import models


class PosSession(models.Model):
    _inherit = 'pos.session'

    def _pos_ui_models_to_load(self):
        result = super()._pos_ui_models_to_load()
        # Loaded once at session start, only for POS that enable the feature.
        if self.config_id.multi_uom_barcode_selling and 'product.uom.barcode' not in result:
            result.append('product.uom.barcode')
        return result

    def _mub_uom_barcode_domain(self):
        self.ensure_one()
        config = self.config_id
        domain = [
            ('product_id', '!=', False),
            ('product_id.active', '=', True),
            ('product_id.sale_ok', '=', True),
            ('product_id.available_in_pos', '=', True),
            '|', ('company_id', '=', False), ('company_id', '=', config.company_id.id),
        ]
        if config.limit_categories and config.iface_available_categ_ids:
            domain.append(('product_id.pos_categ_id', 'child_of', config.iface_available_categ_ids.ids))
        return domain

    def _loader_params_product_uom_barcode(self):
        return {
            'search_params': {
                'domain': self._mub_uom_barcode_domain(),
                'fields': ['barcode', 'product_id', 'uom_id'],
            },
        }

    def _get_pos_ui_product_uom_barcode(self, params):
        return self.env['product.uom.barcode'].search_read(**params['search_params'])

    def _mub_resolve_uom_barcode(self, barcode, quantity=1.0):
        """Server-side mirror of a POS scan of a UoM barcode.

        Returns the product, unit of measure, quantity and pricelist-aware unit
        price the POS would put on the order line, or ``False`` when the barcode
        is not a UoM barcode of this POS.
        """
        self.ensure_one()
        if not self.config_id.multi_uom_barcode_selling or not barcode:
            return False
        record = self.env['product.uom.barcode'].search(
            self._mub_uom_barcode_domain() + [('barcode', '=', barcode.strip())], limit=1)
        if not record:
            return False
        product = record.product_id
        return {
            'product_id': product.id,
            'uom_id': record.uom_id.id,
            'quantity': quantity,
            'price_unit': product._mub_get_pos_uom_price(
                record.uom_id, self.config_id.pricelist_id, quantity),
        }
