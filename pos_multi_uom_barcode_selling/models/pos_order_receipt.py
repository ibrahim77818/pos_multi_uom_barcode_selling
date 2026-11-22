# -*- coding: utf-8 -*-
from odoo import models


class PosOrderReceipt(models.AbstractModel):
    _inherit = 'pos.order.receipt'

    # Odoo 20 builds receipts from line data, on the server (this method) and
    # in the POS (static/src/js/receipt.js, GeneratePrinterData). Both must
    # give the same keys.
    def _order_receipt_generate_line_data(self):
        line_data = super()._order_receipt_generate_line_data()
        for data, line in zip(line_data, self.lines):
            data['mub_uom_name'] = False
            if line._mub_is_secondary_uom():
                data['product_uom_name'] = line.product_uom_id.name
                data['mub_uom_name'] = line.product_uom_id.name
        return line_data
