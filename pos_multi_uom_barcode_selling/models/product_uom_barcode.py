# -*- coding: utf-8 -*-
from odoo import _, api, fields, models
from odoo.exceptions import ValidationError


class ProductUomBarcode(models.Model):
    """Barcode of a product sold in a secondary unit of measure.

    Resolution of these barcodes is scoped to the Point of Sale: they are only
    loaded into POS sessions that enable Multi-UoM Barcode Selling, and they are
    not used by the product name search or by other applications.
    """
    _name = 'product.uom.barcode'
    _inherit = ['pos.load.mixin']
    _description = 'Product UoM Barcode'
    _order = 'product_tmpl_id, sequence, id'
    _rec_name = 'barcode'

    sequence = fields.Integer(string='Sequence', default=10)
    barcode = fields.Char(string='Barcode', required=True, index=True, copy=False)
    product_tmpl_id = fields.Many2one(
        'product.template', string='Product Template',
        required=True, ondelete='cascade', index=True,
    )
    product_id = fields.Many2one(
        'product.product', string='Product Variant',
        compute='_compute_product_id', store=True, readonly=False,
        ondelete='cascade', index=True,
        domain="[('product_tmpl_id', '=', product_tmpl_id)]",
        help='Variant sold with this barcode. Filled automatically when the '
             'product has a single variant.',
    )
    product_uom_id = fields.Many2one(
        related='product_tmpl_id.uom_id', string='Main Unit of Measure',
    )
    product_uom_category_id = fields.Many2one(
        related='product_tmpl_id.uom_id.category_id', string='UoM Category',
    )
    uom_id = fields.Many2one(
        'uom.uom', string='Unit of Measure', required=True, ondelete='restrict',
        domain="[('category_id', '=', product_uom_category_id), ('id', '!=', product_uom_id)]",
        help='Secondary unit of measure sold when this barcode is scanned in the '
             'Point of Sale. It must belong to the category of the main unit '
             'and cannot be the main unit itself.',
    )
    qty_in_main_uom = fields.Float(
        string='Quantity in Main UoM', compute='_compute_conversion',
        digits='Product Unit of Measure',
        help='How many main units one unit of this UoM represents.',
    )
    lst_price_uom = fields.Float(
        string='Sales Price per UoM', compute='_compute_conversion',
        digits='Product Price',
        help='Sales price of one unit of this UoM, converted from the product '
             'sales price (before pricelists and taxes).',
    )
    company_id = fields.Many2one(
        related='product_tmpl_id.company_id', string='Company',
        store=True, index=True,
    )

    _sql_constraints = [
        ('barcode_uniq', 'unique(barcode)',
         'A UoM barcode can only be assigned to one product unit of measure.'),
    ]

    # ------------------------------------------------------------------
    # Computes
    # ------------------------------------------------------------------
    @api.depends('product_tmpl_id', 'product_tmpl_id.product_variant_ids')
    def _compute_product_id(self):
        for rec in self:
            if rec.product_id and rec.product_id.product_tmpl_id == rec.product_tmpl_id:
                rec.product_id = rec.product_id
                continue
            variants = rec.product_tmpl_id.product_variant_ids
            rec.product_id = variants if len(variants) == 1 else False

    @api.depends('uom_id', 'product_tmpl_id.uom_id', 'product_tmpl_id.list_price',
                 'product_id.lst_price')
    def _compute_conversion(self):
        for rec in self:
            main_uom = rec.product_tmpl_id.uom_id
            if not rec.uom_id or not main_uom or rec.uom_id.category_id != main_uom.category_id:
                rec.qty_in_main_uom = 0.0
                rec.lst_price_uom = 0.0
                continue
            rec.qty_in_main_uom = rec.uom_id._compute_quantity(1.0, main_uom, round=False)
            price = rec.product_id.lst_price if rec.product_id else rec.product_tmpl_id.list_price
            rec.lst_price_uom = main_uom._compute_price(price, rec.uom_id)

    # ------------------------------------------------------------------
    # POS data loading (pos.load.mixin): loaded once, only for POS that
    # enable Multi-UoM Barcode Selling.
    # ------------------------------------------------------------------
    @api.model
    def _mub_pos_domain(self, config):
        domain = [
            ('product_id', '!=', False),
            ('product_id.active', '=', True),
            ('product_id.sale_ok', '=', True),
            ('product_id.available_in_pos', '=', True),
            '|', ('company_id', '=', False), ('company_id', '=', config.company_id.id),
        ]
        if config.limit_categories and config.iface_available_categ_ids:
            domain.append(('product_id.pos_categ_ids', 'child_of', config.iface_available_categ_ids.ids))
        return domain

    @api.model
    def _load_pos_data_domain(self, data):
        config = self.env['pos.config'].browse(data['pos.config']['data'][0]['id'])
        if not config.multi_uom_barcode_selling:
            return False
        return self._mub_pos_domain(config)

    @api.model
    def _load_pos_data_fields(self, config_id):
        return ['id', 'barcode', 'product_id', 'uom_id']

    # ------------------------------------------------------------------
    # CRUD
    # ------------------------------------------------------------------
    @api.model
    def _mub_normalize_vals(self, vals):
        if 'barcode' in vals and isinstance(vals['barcode'], str):
            vals['barcode'] = vals['barcode'].strip()
        return vals

    @api.model_create_multi
    def create(self, vals_list):
        return super().create([self._mub_normalize_vals(dict(vals)) for vals in vals_list])

    def write(self, vals):
        return super().write(self._mub_normalize_vals(dict(vals)))

    # ------------------------------------------------------------------
    # Constraints
    # ------------------------------------------------------------------
    @api.constrains('uom_id', 'product_tmpl_id', 'product_id')
    def _check_uom(self):
        for rec in self:
            tmpl = rec.product_tmpl_id
            if rec.product_id and rec.product_id.product_tmpl_id != tmpl:
                raise ValidationError(_(
                    'The variant of the UoM barcode "%(barcode)s" must belong to the product %(product)s.',
                    barcode=rec.barcode, product=tmpl.display_name,
                ))
            if not rec.product_id and len(tmpl.product_variant_ids) > 1:
                raise ValidationError(_(
                    'Please select the product variant sold with the UoM barcode "%(barcode)s".',
                    barcode=rec.barcode,
                ))
            if rec.uom_id == tmpl.uom_id:
                raise ValidationError(_(
                    'The UoM barcode "%(barcode)s" cannot use %(uom)s because it is the main '
                    'unit of measure of %(product)s. The main unit is sold with the product barcode.',
                    barcode=rec.barcode, uom=rec.uom_id.name, product=tmpl.display_name,
                ))
            if rec.uom_id.category_id != tmpl.uom_id.category_id:
                raise ValidationError(_(
                    'The unit of measure %(uom)s of the UoM barcode "%(barcode)s" must belong to the '
                    'same category as the main unit of measure of %(product)s (%(category)s).',
                    uom=rec.uom_id.name, barcode=rec.barcode, product=tmpl.display_name,
                    category=tmpl.uom_id.category_id.name,
                ))
            if tmpl.tracking == 'serial':
                raise ValidationError(_(
                    'UoM barcodes cannot be used on %(product)s because it is tracked by serial '
                    'number: each serial number is exactly one main unit.',
                    product=tmpl.display_name,
                ))

    @api.constrains('product_tmpl_id', 'product_id', 'uom_id', 'barcode')
    def _check_available_in_pos(self):
        # Checked when a UoM barcode is created or edited (UI, import, API).
        # Removing "Available in POS" later keeps the barcodes: they are simply
        # not loaded in POS until the product is available again.
        for rec in self:
            if not rec.product_tmpl_id.available_in_pos:
                raise ValidationError(_(
                    'UoM barcodes can only be added to products available in the Point of Sale. '
                    'Enable "Available in POS" on %(product)s first.',
                    product=rec.product_tmpl_id.display_name,
                ))

    @api.constrains('barcode')
    def _check_barcode_conflicts(self):
        Product = self.env['product.product'].sudo().with_context(active_test=False)
        Packaging = self.env['product.packaging'].sudo()
        for rec in self:
            if not rec.barcode:
                raise ValidationError(_('A UoM barcode cannot be empty.'))
            product = Product.search([('barcode', '=', rec.barcode)], limit=1)
            if product:
                raise ValidationError(_(
                    'The barcode "%(barcode)s" is already the main barcode of the product %(product)s.',
                    barcode=rec.barcode, product=product.display_name,
                ))
            packaging = Packaging.search([('barcode', '=', rec.barcode)], limit=1)
            if packaging:
                raise ValidationError(_(
                    'The barcode "%(barcode)s" is already used by the packaging %(packaging)s.',
                    barcode=rec.barcode, packaging=packaging.display_name,
                ))
