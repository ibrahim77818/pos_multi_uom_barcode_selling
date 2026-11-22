odoo.define('pos_multi_uom_barcode_selling.MubChangeUomButton', function (require) {
    'use strict';

    const PosComponent = require('point_of_sale.PosComponent');
    const ProductScreen = require('point_of_sale.ProductScreen');
    const Registries = require('point_of_sale.Registries');
    const { useListener } = require('@web/core/utils/hooks');

    class MubChangeUomButton extends PosComponent {
        setup() {
            super.setup();
            useListener('click', this.onClick);
        }

        async onClick() {
            const pos = this.env.pos;
            const order = pos.get_order();
            const line = order && order.get_selected_orderline();
            if (!line) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('No order line selected'),
                    body: this.env._t('Select an order line first, then use Change UoM.'),
                });
                return;
            }
            if (line.is_reward_line || line.refunded_orderline_id) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('Unit of measure cannot be changed'),
                    body: this.env._t('Reward lines and refund lines keep the unit of measure they were created with.'),
                });
                return;
            }
            const uomIds = pos.mubGetProductUomIds(line.product);
            if (uomIds.length < 2) {
                await this.showPopup('ErrorPopup', {
                    title: this.env._t('No secondary units of measure'),
                    body: this.env._t('%s has no secondary unit of measure with a UoM barcode.')
                        .replace('%s', line.get_full_product_name()),
                });
                return;
            }
            const mainId = line.product.uom_id[0];
            const current = line.get_unit();
            const currentId = current ? current.id : mainId;
            // The current unit is marked in the label instead of the popup's
            // "selected" highlight, which is hard to read.
            const list = uomIds.map((id) => {
                const tags = [];
                if (id === mainId) {
                    tags.push(this.env._t('main unit'));
                }
                if (id === currentId) {
                    tags.push(this.env._t('current'));
                }
                const name = pos.units_by_id[id].name;
                return {
                    id,
                    item: id,
                    isSelected: false,
                    // Plain concatenation: Odoo 16's JS minifier strips spaces inside template literals.
                    label: (id === currentId ? '\u2713 ' : '') + name
                        + (tags.length ? ' (' + tags.join(', ') + ')' : ''),
                };
            });
            const { confirmed, payload } = await this.showPopup('SelectionPopup', {
                title: this.env._t('Change Unit of Measure'),
                list,
            });
            if (confirmed && payload && line.mubSetUom(payload)) {
                // Promotions depend on quantities: refresh them like a numpad change does.
                if (typeof order._updateRewards === 'function') {
                    order._updateRewards();
                }
            }
        }
    }
    MubChangeUomButton.template = 'MubChangeUomButton';

    ProductScreen.addControlButton({
        component: MubChangeUomButton,
        condition: function () {
            return this.env.pos.mubIsEnabled && this.env.pos.mubIsEnabled();
        },
    });

    Registries.Component.add(MubChangeUomButton);

    return MubChangeUomButton;
});
