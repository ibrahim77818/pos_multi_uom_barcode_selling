# -*- coding: utf-8 -*-
from odoo import api, models


class PosSession(models.Model):
    _inherit = 'pos.session'

    @api.model
    def _load_pos_data_models(self, config_id):
        result = super()._load_pos_data_models(config_id)
        if 'product.uom.barcode' not in result:
            # The model's own domain returns nothing when the POS does not
            # enable Multi-UoM Barcode Selling.
            result.append('product.uom.barcode')
        return result

    def find_product_by_barcode(self, barcode, config_id):
        """Products not loaded yet ("Limited Product Loading"): also resolve
        UoM barcodes, so a scan can load the product on demand."""
        result = super().find_product_by_barcode(barcode, config_id)
        if result.get('product.product'):
            return result
        config = self.env['pos.config'].browse(config_id)
        if not config.multi_uom_barcode_selling or not barcode:
            return result
        uom_barcode = self.env['product.uom.barcode'].search(
            self.env['product.uom.barcode']._mub_pos_domain(config) + [('barcode', '=', barcode)], limit=1)
        if uom_barcode:
            product_fields = self.env['product.product']._load_pos_data_fields(config_id)
            product = uom_barcode.product_id.with_context(display_default_code=False)
            result = dict(result, **{'product.product': product.read(product_fields, load=False)})
        return result

    def _mub_resolve_uom_barcode(self, barcode, quantity=1.0):
        """Server-side mirror of a POS scan of a UoM barcode.

        Returns the product, unit of measure, quantity and pricelist-aware unit
        price the POS would put on the order line, or ``False`` when the barcode
        is not a UoM barcode of this POS.
        """
        self.ensure_one()
        config = self.config_id
        if not config.multi_uom_barcode_selling or not barcode:
            return False
        record = self.env['product.uom.barcode'].search(
            self.env['product.uom.barcode']._mub_pos_domain(config) + [('barcode', '=', barcode.strip())],
            limit=1)
        if not record:
            return False
        product = record.product_id
        return {
            'product_id': product.id,
            'uom_id': record.uom_id.id,
            'quantity': quantity,
            'price_unit': product._mub_get_pos_uom_price(record.uom_id, config.pricelist_id, quantity),
        }
