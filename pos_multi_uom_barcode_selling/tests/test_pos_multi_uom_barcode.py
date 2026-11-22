# -*- coding: utf-8 -*-
from psycopg2 import IntegrityError

from odoo.exceptions import ValidationError
from odoo.tests import tagged
from odoo.tests.common import TransactionCase
from odoo.tools import mute_logger


@tagged('post_install', '-at_install')
class TestPosMultiUomBarcode(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.env = cls.env(context=dict(cls.env.context, tracking_disable=True))
        cls.company = cls.env.company
        # POS pickings are created when the order is processed.
        cls.company.point_of_sale_update_stock_quantities = 'real'

        cls.uom_gram = cls.env.ref('uom.product_uom_gram')
        cls.uom_kg = cls.env.ref('uom.product_uom_kgm')
        cls.uom_ton = cls.env.ref('uom.product_uom_ton')
        cls.uom_unit = cls.env.ref('uom.product_uom_unit')

        cls.product = cls.env['product.product'].create({
            'name': 'MUB Sugar',
            'detailed_type': 'product',
            'available_in_pos': True,
            'sale_ok': True,
            'uom_id': cls.uom_gram.id,
            'uom_po_id': cls.uom_gram.id,
            'list_price': 1.0,          # 1 GM = 1.0
            'standard_price': 0.5,
            'barcode': 'MUB-SUGAR-GM',
            'taxes_id': [(5, 0, 0)],
        })
        cls.template = cls.product.product_tmpl_id
        cls.kg_barcode = cls.env['product.uom.barcode'].create({
            'product_tmpl_id': cls.template.id,
            'uom_id': cls.uom_kg.id,
            'barcode': 'MUB-SUGAR-KG',
        })
        cls.ton_barcode = cls.env['product.uom.barcode'].create({
            'product_tmpl_id': cls.template.id,
            'uom_id': cls.uom_ton.id,
            'barcode': 'MUB-SUGAR-TON',
        })

        cls.pricelist = cls.env['product.pricelist'].create({
            'name': 'MUB Pricelist',
            'currency_id': cls.company.currency_id.id,
            'company_id': cls.company.id,
        })
        cls.config = cls.env['pos.config'].create({
            'name': 'MUB Shop',
            'pricelist_id': cls.pricelist.id,
            'available_pricelist_ids': [(6, 0, cls.pricelist.ids)],
        })

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _open_session(self, enabled=True):
        self.config.multi_uom_barcode_selling = enabled
        return self.env['pos.session'].create({'config_id': self.config.id})

    def _line_vals(self, product, qty, price_unit, uom=None, **extra):
        vals = {
            'product_id': product.id,
            'full_product_name': product.display_name,
            'qty': qty,
            'price_unit': price_unit,
            'price_subtotal': qty * price_unit,
            'price_subtotal_incl': qty * price_unit,
        }
        if uom:
            vals['product_uom_id'] = uom.id
        vals.update(extra)
        return vals

    def _create_order(self, session, lines_vals):
        total = sum(vals['price_subtotal_incl'] for vals in lines_vals)
        return self.env['pos.order'].create({
            'session_id': session.id,
            'pricelist_id': self.pricelist.id,
            'amount_tax': 0.0,
            'amount_total': total,
            'amount_paid': total,
            'amount_return': 0.0,
            'lines': [(0, 0, vals) for vals in lines_vals],
        })

    def _product_moves(self, product):
        return self.env['stock.move'].search([('product_id', '=', product.id)])

    # ------------------------------------------------------------------
    # 1. configuration
    # ------------------------------------------------------------------
    def test_01_configuration_default_disabled(self):
        config = self.env['pos.config'].create({'name': 'MUB Default Shop'})
        self.assertFalse(config.multi_uom_barcode_selling)

        settings = self.env['res.config.settings'].create({'pos_config_id': config.id})
        self.assertFalse(settings.pos_multi_uom_barcode_selling)
        settings.pos_multi_uom_barcode_selling = True
        settings.execute()
        self.assertTrue(config.multi_uom_barcode_selling)

    def test_02_session_loads_barcodes_only_when_enabled(self):
        session = self._open_session(enabled=False)
        self.assertNotIn('product.uom.barcode', session._pos_ui_models_to_load())
        self.assertFalse(session._mub_resolve_uom_barcode('MUB-SUGAR-KG'))

        self.config.multi_uom_barcode_selling = True
        self.assertIn('product.uom.barcode', session._pos_ui_models_to_load())
        params = session._loader_params_product_uom_barcode()
        records = session._get_pos_ui_product_uom_barcode(params)
        by_barcode = {record['barcode']: record for record in records}
        self.assertEqual(by_barcode['MUB-SUGAR-KG']['product_id'][0], self.product.id)
        self.assertEqual(by_barcode['MUB-SUGAR-KG']['uom_id'][0], self.uom_kg.id)
        self.assertIn('MUB-SUGAR-TON', by_barcode)

        # Products not available in POS are not loaded (POS-scoped resolution).
        self.product.available_in_pos = False
        records = session._get_pos_ui_product_uom_barcode(session._loader_params_product_uom_barcode())
        self.assertNotIn('MUB-SUGAR-KG', [record['barcode'] for record in records])

    # ------------------------------------------------------------------
    # 2. UoM barcode validation
    # ------------------------------------------------------------------
    def test_10_variant_filled_automatically(self):
        self.assertEqual(self.kg_barcode.product_id, self.product)
        self.assertAlmostEqual(self.kg_barcode.qty_in_main_uom, 1000.0)
        self.assertAlmostEqual(self.kg_barcode.lst_price_uom, 1000.0)

    def test_11_main_uom_is_excluded(self):
        with self.assertRaises(ValidationError):
            self.env['product.uom.barcode'].create({
                'product_tmpl_id': self.template.id,
                'uom_id': self.uom_gram.id,
                'barcode': 'MUB-SUGAR-GM-2',
            })

    def test_12_uom_must_share_category(self):
        with self.assertRaises(ValidationError):
            self.env['product.uom.barcode'].create({
                'product_tmpl_id': self.template.id,
                'uom_id': self.uom_unit.id,
                'barcode': 'MUB-SUGAR-UNIT',
            })

    def test_13_main_uom_cannot_become_a_secondary_uom(self):
        with self.assertRaises(ValidationError):
            self.template.write({'uom_id': self.uom_kg.id, 'uom_po_id': self.uom_kg.id})

    def test_14_duplicate_uom_barcode_rejected_by_database(self):
        other = self.env['product.product'].create({
            'name': 'MUB Rice', 'available_in_pos': True,
            'uom_id': self.uom_gram.id, 'uom_po_id': self.uom_gram.id,
        })
        with mute_logger('odoo.sql_db'), self.assertRaises(IntegrityError), self.cr.savepoint():
            self.env['product.uom.barcode'].create({
                'product_tmpl_id': other.product_tmpl_id.id,
                'uom_id': self.uom_kg.id,
                'barcode': 'MUB-SUGAR-KG',
            })

    def test_15_uom_barcode_cannot_reuse_product_barcode(self):
        with self.assertRaises(ValidationError):
            self.env['product.uom.barcode'].create({
                'product_tmpl_id': self.template.id,
                'uom_id': self.uom_kg.id,
                'barcode': 'MUB-SUGAR-GM',
            })

    def test_16_product_barcode_cannot_reuse_uom_barcode(self):
        with self.assertRaises(ValidationError):
            self.env['product.product'].create({
                'name': 'MUB Salt', 'barcode': 'MUB-SUGAR-KG',
            })
        with self.assertRaises(ValidationError):
            self.env['product.packaging'].create({
                'name': 'MUB Sugar Bag', 'product_id': self.product.id,
                'qty': 500, 'barcode': 'MUB-SUGAR-TON',
            })

    def test_17_barcode_is_trimmed(self):
        record = self.env['product.uom.barcode'].create({
            'product_tmpl_id': self.template.id,
            'uom_id': self.env.ref('uom.product_uom_oz').id,
            'barcode': '  MUB-SUGAR-OZ  ',
        })
        self.assertEqual(record.barcode, 'MUB-SUGAR-OZ')

    def test_18_serial_tracked_products_rejected(self):
        serial = self.env['product.product'].create({
            'name': 'MUB Serial Scale', 'detailed_type': 'product', 'tracking': 'serial',
            'available_in_pos': True,
            'uom_id': self.uom_gram.id, 'uom_po_id': self.uom_gram.id,
        })
        with self.assertRaises(ValidationError):
            self.env['product.uom.barcode'].create({
                'product_tmpl_id': serial.product_tmpl_id.id,
                'uom_id': self.uom_kg.id,
                'barcode': 'MUB-SERIAL-KG',
            })

    def test_19_only_pos_products(self):
        not_pos = self.env['product.product'].create({
            'name': 'MUB Back Office Flour', 'available_in_pos': False,
            'uom_id': self.uom_gram.id, 'uom_po_id': self.uom_gram.id,
        })
        with self.assertRaises(ValidationError):
            self.env['product.uom.barcode'].create({
                'product_tmpl_id': not_pos.product_tmpl_id.id,
                'uom_id': self.uom_kg.id,
                'barcode': 'MUB-FLOUR-KG',
            })
        # Removing the flag later keeps existing barcodes (they are just not loaded in POS).
        self.template.available_in_pos = False
        self.assertTrue(self.kg_barcode.exists())

    # ------------------------------------------------------------------
    # 3. scan conversion and pricelists
    # ------------------------------------------------------------------
    def test_20_scan_converts_quantity_and_price(self):
        session = self._open_session()
        kg = session._mub_resolve_uom_barcode('MUB-SUGAR-KG')
        self.assertEqual(kg['product_id'], self.product.id)
        self.assertEqual(kg['uom_id'], self.uom_kg.id)
        self.assertEqual(kg['quantity'], 1.0)
        self.assertAlmostEqual(kg['price_unit'], 1000.0, places=2)   # 1 GM = 1 => 1 KG = 1000

        ton = session._mub_resolve_uom_barcode('MUB-SUGAR-TON')
        self.assertAlmostEqual(ton['price_unit'], 1000000.0, places=2)
        # The main barcode is not a UoM barcode: standard POS handles it.
        self.assertFalse(session._mub_resolve_uom_barcode('MUB-SUGAR-GM'))

    def test_21_pricelist_min_quantity_uses_main_uom(self):
        self.env['product.pricelist.item'].create({
            'pricelist_id': self.pricelist.id,
            'applied_on': '0_product_variant',
            'product_id': self.product.id,
            'min_quantity': 500,           # 500 GM
            'compute_price': 'fixed',
            'fixed_price': 0.8,
        })
        session = self._open_session()
        # 1 KG = 1000 GM >= 500 GM: the rule applies, 0.8 x 1000.
        kg = session._mub_resolve_uom_barcode('MUB-SUGAR-KG')
        self.assertAlmostEqual(kg['price_unit'], 800.0, places=2)
        # Main UoM below the threshold keeps the list price.
        price_gm = self.product._mub_get_pos_uom_price(self.uom_gram, self.pricelist, 1)
        self.assertAlmostEqual(price_gm, 1.0, places=2)

    def test_22_percentage_pricelist_on_secondary_uom(self):
        self.env['product.pricelist.item'].create({
            'pricelist_id': self.pricelist.id,
            'applied_on': '3_global',
            'compute_price': 'percentage',
            'percent_price': 10,
        })
        price = self.product._mub_get_pos_uom_price(self.uom_kg, self.pricelist, 2)
        self.assertAlmostEqual(price, 900.0, places=2)

    # ------------------------------------------------------------------
    # 4. manual UoM switching on order lines
    # ------------------------------------------------------------------
    def test_30_manual_uom_switch_on_line(self):
        session = self._open_session()
        order = self._create_order(session, [self._line_vals(self.product, 2, 1000.0, self.uom_kg)])
        line = order.lines
        self.assertEqual(line.product_uom_id, self.uom_kg)
        self.assertAlmostEqual(line._mub_get_product_uom_qty(), 2000.0)

        line.write({'product_uom_id': self.uom_ton.id, 'qty': 0.002, 'price_unit': 1000000.0})
        self.assertAlmostEqual(line._mub_get_product_uom_qty(), 2000.0)

        with self.assertRaises(ValidationError):
            line.product_uom_id = self.uom_unit

    def test_31_line_without_uom_uses_product_uom(self):
        session = self._open_session()
        order = self._create_order(session, [self._line_vals(self.product, 5, 1.0)])
        self.assertEqual(order.lines.product_uom_id, self.uom_gram)
        self.assertFalse(order.lines._mub_is_secondary_uom())

    def test_32_invalid_uom_from_pos_is_sanitized(self):
        line = self.env['pos.order.line']._order_line_fields(
            [0, 0, self._line_vals(self.product, 1, 1.0, self.uom_unit)])
        self.assertEqual(line[2]['product_uom_id'], self.uom_gram.id)

    def test_33_export_for_ui_contains_uom(self):
        session = self._open_session()
        order = self._create_order(session, [self._line_vals(self.product, 1, 1000.0, self.uom_kg)])
        exported = order.lines.export_for_ui()
        self.assertEqual(exported[0]['product_uom_id'], self.uom_kg.id)

    # ------------------------------------------------------------------
    # 5. stock moves, move lines and costs
    # ------------------------------------------------------------------
    def test_40_stock_moves_keep_line_uom(self):
        session = self._open_session()
        order = self._create_order(session, [
            self._line_vals(self.product, 2, 1000.0, self.uom_kg),
            self._line_vals(self.product, 1, 1000000.0, self.uom_ton),
            self._line_vals(self.product, 300, 1.0),
        ])
        order._create_order_picking()

        moves = self._product_moves(self.product)
        self.assertEqual(len(moves), 3, 'one move per (product, UoM)')
        kg_move = moves.filtered(lambda m: m.product_uom == self.uom_kg)
        ton_move = moves.filtered(lambda m: m.product_uom == self.uom_ton)
        gm_move = moves.filtered(lambda m: m.product_uom == self.uom_gram)
        self.assertAlmostEqual(kg_move.product_uom_qty, 2.0)
        self.assertAlmostEqual(kg_move.product_qty, 2000.0)
        self.assertAlmostEqual(ton_move.product_qty, 1000000.0)
        self.assertAlmostEqual(gm_move.product_qty, 300.0)
        self.assertAlmostEqual(sum(moves.mapped('product_qty')), 1002300.0)

        for move in kg_move | ton_move:
            self.assertTrue(move.move_line_ids)
            self.assertEqual(move.move_line_ids.product_uom_id, move.product_uom)
            self.assertAlmostEqual(sum(move.move_line_ids.mapped('quantity')), move.product_uom_qty)

    def test_41_refund_moves_keep_line_uom(self):
        session = self._open_session()
        order = self._create_order(session, [self._line_vals(self.product, -1, 1000.0, self.uom_kg)])
        order._create_order_picking()
        move = self._product_moves(self.product)
        self.assertEqual(move.product_uom, self.uom_kg)
        self.assertAlmostEqual(move.product_qty, 1000.0)

    def test_42_total_cost_in_main_uom(self):
        session = self._open_session()
        order = self._create_order(session, [self._line_vals(self.product, 2, 1000.0, self.uom_kg)])
        line = order.lines
        line.is_total_cost_computed = False
        line._compute_total_cost(self.env['stock.move'])
        # 2 KG = 2000 GM x 0.5 standard cost per GM
        self.assertAlmostEqual(line.total_cost, 1000.0, places=2)

    def test_43_invoice_line_uses_line_uom(self):
        session = self._open_session()
        order = self._create_order(session, [self._line_vals(self.product, 2, 1000.0, self.uom_kg)])
        invoice_lines = [cmd[2] for cmd in order._prepare_invoice_lines() if cmd[2].get('product_id')]
        self.assertEqual(invoice_lines[0]['product_uom_id'], self.uom_kg.id)
        self.assertEqual(invoice_lines[0]['price_unit'], 1000.0)

    # ------------------------------------------------------------------
    # 6. loyalty / promotions
    # ------------------------------------------------------------------
    def test_50_loyalty_reward_lines(self):
        program = self.env['loyalty.program'].create({
            'name': 'MUB 10% from 500 g',
            'program_type': 'promotion',
            'trigger': 'auto',
            'applies_on': 'current',
            'pos_ok': True,
            'pos_config_ids': [(4, self.config.id)],
            'rule_ids': [(0, 0, {
                'product_ids': [(6, 0, self.product.ids)],
                'minimum_qty': 500,
                'reward_point_mode': 'order',
                'reward_point_amount': 1,
            })],
            'reward_ids': [(0, 0, {
                'reward_type': 'discount',
                'discount': 10,
                'discount_mode': 'percent',
                'discount_applicability': 'order',
                'required_points': 1,
            })],
        })
        reward = program.reward_ids
        session = self._open_session()
        order = self._create_order(session, [
            self._line_vals(self.product, 1, 1000.0, self.uom_kg),
            self._line_vals(reward.discount_line_product_id, 1, -100.0,
                            is_reward_line=True, reward_id=reward.id),
        ])
        sugar_line = order.lines.filtered(lambda l: l.product_id == self.product)
        reward_line = order.lines - sugar_line
        # Rule quantities are in the main UoM: 1 KG satisfies "minimum 500 g".
        self.assertGreaterEqual(sugar_line._mub_get_product_uom_qty(), program.rule_ids.minimum_qty)
        self.assertEqual(reward_line.product_uom_id, reward.discount_line_product_id.uom_id)
        self.assertAlmostEqual(order.amount_total, 900.0)

        order._create_order_picking()
        move = self._product_moves(self.product)
        self.assertEqual(move.product_uom, self.uom_kg)
        self.assertFalse(self._product_moves(reward.discount_line_product_id))
