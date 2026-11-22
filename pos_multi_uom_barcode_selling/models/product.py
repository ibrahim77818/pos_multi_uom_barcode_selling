# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    uom_barcode_ids = fields.One2many(
        'product.uom.barcode', 'product_tmpl_id', string='UoM Barcodes', copy=False,
        help='Barcodes that sell this product in a secondary unit of measure in the Point of Sale.',
    )

    @api.constrains('uom_id', 'tracking')
    def _check_mub_uom_barcodes(self):
        # Re-validate the UoM barcodes when the main UoM or the tracking changes
        # (e.g. the main UoM becomes one of the secondary UoMs).
        self.uom_barcode_ids._check_uom()


class ProductProduct(models.Model):
    _inherit = 'product.product'

    uom_barcode_ids = fields.One2many(
        'product.uom.barcode', 'product_id', string='UoM Barcodes',
    )

    @api.constrains('barcode')
    def _check_mub_barcode_not_uom_barcode(self):
        barcodes = [barcode for barcode in self.mapped('barcode') if barcode]
        if not barcodes:
            return
        conflict = self.env['product.uom.barcode'].sudo().search([('barcode', 'in', barcodes)], limit=1)
        if conflict:
            raise ValidationError(_(
                'The barcode "%(barcode)s" is already a UoM barcode of the product %(product)s (%(uom)s).',
                barcode=conflict.barcode, product=conflict.product_tmpl_id.display_name,
                uom=conflict.uom_id.name,
            ))

    def _mub_get_pos_uom_price(self, uom, pricelist=False, quantity=1.0):
        """Unit price of this product expressed in ``uom``.

        Server-side mirror of the POS computation: the pricelist is evaluated on
        the quantity converted to the product's main UoM (so ``min_quantity`` of
        pricelist rules keeps its meaning), and the resulting main-UoM price is
        converted to ``uom``.
        """
        self.ensure_one()
        uom = uom or self.uom_id
        base_qty = uom._compute_quantity(quantity, self.uom_id, round=False) if uom != self.uom_id else quantity
        if pricelist:
            base_price = pricelist._get_product_price(self, base_qty, uom=self.uom_id)
        else:
            base_price = self.lst_price
        if uom == self.uom_id:
            return base_price
        return self.uom_id._compute_price(base_price, uom)


class ProductPackaging(models.Model):
    _inherit = 'product.packaging'

    @api.constrains('barcode')
    def _check_mub_barcode_not_uom_barcode(self):
        barcodes = [barcode for barcode in self.mapped('barcode') if barcode]
        if not barcodes:
            return
        conflict = self.env['product.uom.barcode'].sudo().search([('barcode', 'in', barcodes)], limit=1)
        if conflict:
            raise ValidationError(_(
                'The barcode "%(barcode)s" is already a UoM barcode of the product %(product)s (%(uom)s).',
                barcode=conflict.barcode, product=conflict.product_tmpl_id.display_name,
                uom=conflict.uom_id.name,
            ))
