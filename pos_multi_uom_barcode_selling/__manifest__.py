# -*- coding: utf-8 -*-
{
    'name': 'POS Multi-UoM Barcode Selling',
    'version': '18.0.1.1.3',
    'category': 'Sales/Point of Sale',
    'summary': 'Sell POS products in secondary units of measure (KG, Ton, Dozen...) '
               'by scanning UoM barcodes or switching the unit on the order line.',
    'description': """
POS Multi-UoM Barcode Selling
=============================
* Per-POS switch to enable Multi-UoM Barcode Selling (disabled by default).
* "UoM Barcodes" tab on POS products: one barcode per secondary unit of measure
  (the product's main UoM is excluded so it never conflicts with the main barcode).
* Database and ORM uniqueness against other UoM barcodes, product barcodes and
  packaging barcodes.
* UoM barcodes are indexed once at POS session start: scans and unit changes run
  in memory without extra RPCs.
* Scanning a UoM barcode adds 1 unit of that UoM with the converted, pricelist-aware price.
* "Change UoM" control button to switch the unit of the selected order line.
* Loyalty / promotion quantity rules count secondary-UoM lines in the main UoM
  (1 KG satisfies "minimum 500 g"); amount rules use the real line totals.
* The selected UoM is printed on receipts and stored on POS order lines, invoices,
  stock moves and stock move lines.
* English and Arabic.
""",
    'author': 'Ibrahim Yahia',
    'website': 'https://www.linkedin.com/in/ibrahim-yahia',
    'license': 'LGPL-3',
    'depends': ['point_of_sale', 'pos_loyalty'],
    'data': [
        'security/ir.model.access.csv',
        'security/pos_multi_uom_barcode_security.xml',
        'views/product_views.xml',
        'views/res_config_settings_views.xml',
    ],
    'assets': {
        'point_of_sale._assets_pos': [
            'pos_multi_uom_barcode_selling/static/src/**/*',
        ],
    },
    'images': ['static/description/banner.png'],
    'installable': True,
    'application': False,
    'auto_install': False,
}
