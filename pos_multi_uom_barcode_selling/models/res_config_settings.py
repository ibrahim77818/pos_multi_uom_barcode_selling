# -*- coding: utf-8 -*-
from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    pos_multi_uom_barcode_selling = fields.Boolean(
        related='pos_config_id.multi_uom_barcode_selling',
        readonly=False,
        string='Multi-UoM Barcode Selling',
        help='Allow cashiers of this point of sale to sell products in secondary '
             'units of measure, by scanning the UoM barcodes defined on the '
             'products or by changing the unit of an order line.',
    )
