# -*- coding: utf-8 -*-
from odoo import fields, models


class PosConfig(models.Model):
    _inherit = 'pos.config'

    multi_uom_barcode_selling = fields.Boolean(
        string='Multi-UoM Barcode Selling',
        default=False,
        help='Allow cashiers of this point of sale to sell products in secondary '
             'units of measure, by scanning the UoM barcodes defined on the '
             'products or by changing the unit of an order line.',
    )
