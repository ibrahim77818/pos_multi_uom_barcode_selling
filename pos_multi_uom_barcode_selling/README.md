# POS Multi-UoM Barcode Selling (Odoo 16, Community & Enterprise)

Sell POS products in secondary units of measure (KG / Ton for a product stocked in GM, Dozen for
a product stocked in Units...) by scanning a UoM barcode or by switching the unit of an order line.

## Setup
1. Point of Sale › Configuration › Settings › select the POS › **Multi-UoM Barcode Selling** (off by default).
2. Open a product that is *Available in POS* › **UoM Barcodes** tab › add one line per secondary UoM
   (variant column appears for multi-variant products). The main UoM is not selectable.
3. Reload the POS session.

## Behaviour
| Area | What happens |
|---|---|
| Session start | `product.uom.barcode` is loaded once (only for POS that enable the option) and indexed in `PosGlobalState._processData()`; scans and UoM changes then work from in-memory Maps. |
| Scan | A UoM barcode adds the product with qty 1 in that UoM. Price = pricelist price evaluated on the main-UoM quantity × conversion (1 GM = 1 → 1 KG = 1000). Variant/lot popups still apply; the weighing scale is skipped. |
| Change UoM | Control button on the product screen; lists the main UoM + UoMs that have a UoM barcode. Quantity number is kept; the price is recomputed (or converted proportionally for manual prices). Lines with different UoMs never merge. |
| Pricelists | Rule `min_quantity` is compared in the product's main UoM; changing the order pricelist recomputes UoM lines. |
| Loyalty | Amount-based rules use the real line totals; quantity rules count main-UoM quantities (1 KG satisfies "min 500 g"). `pos_loyalty` is a dependency. |
| Receipts | UoM badge on the order line; the receipt prints "Unit of Measure: KG" under the product and "1 KG x price". |
| Backend | `pos.order.line.product_uom_id` becomes the stored, sold UoM (filled by SQL on install). Invoices, refunds, margins (`total_cost` in main UoM) follow it. |
| Stock | Lines are grouped per (product, UoM): each `stock.move` / `stock.move.line` carries the line UoM; `product_qty` and valuation are converted by standard stock. |

## Validation
* SQL `unique(barcode)` + ORM checks against product barcodes and packaging barcodes (both directions).
* UoM must be in the main UoM category and cannot be the main UoM (also re-checked when the product's UoM changes).
* Serial-tracked products cannot have UoM barcodes.
* UoM barcodes can only be created for products available in POS (UI, import and API).

## Tests
```
odoo-bin -c /etc/odoo16.conf -d <db> -i pos_multi_uom_barcode_selling --test-tags /pos_multi_uom_barcode_selling --stop-after-init
```
POS JavaScript behaviour is not
covered by these `TransactionCase` tests (it needs a tour/QUnit test).

## Known limitations
* Point of Sale › Reporting › Orders (`report.pos.order`) sums raw line quantities, as in standard Odoo.
