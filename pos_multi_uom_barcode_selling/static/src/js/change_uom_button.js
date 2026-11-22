/** @odoo-module */

import { Component } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { useService } from "@web/core/utils/hooks";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { SelectionPopup } from "@point_of_sale/app/utils/input_popups/selection_popup";
import { ErrorPopup } from "@point_of_sale/app/errors/popups/error_popup";

export class MubChangeUomButton extends Component {
    static template = "pos_multi_uom_barcode_selling.MubChangeUomButton";

    setup() {
        this.pos = usePos();
        this.popup = useService("popup");
    }

    async click() {
        const order = this.pos.get_order();
        const line = order && order.get_selected_orderline();
        if (!line) {
            await this.popup.add(ErrorPopup, {
                title: _t("No order line selected"),
                body: _t("Select an order line first, then use Change UoM."),
            });
            return;
        }
        if (line.is_reward_line || line.refunded_orderline_id || line.comboParent ||
                (line.comboLines && line.comboLines.length)) {
            await this.popup.add(ErrorPopup, {
                title: _t("Unit of measure cannot be changed"),
                body: _t("Reward lines and refund lines keep the unit of measure they were created with."),
            });
            return;
        }
        const uomIds = this.pos.mubGetProductUomIds(line.product);
        if (uomIds.length < 2) {
            await this.popup.add(ErrorPopup, {
                title: _t("No secondary units of measure"),
                body: _t("%s has no secondary unit of measure with a UoM barcode.", line.get_full_product_name()),
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
                tags.push(_t("main unit"));
            }
            if (id === currentId) {
                tags.push(_t("current"));
            }
            const name = this.pos.units_by_id[id].name;
            return {
                id,
                item: id,
                isSelected: false,
                // Plain concatenation: the JS minifier can strip spaces in template literals.
                label: (id === currentId ? "✓ " : "") + name +
                    (tags.length ? " (" + tags.join(", ") + ")" : ""),
            };
        });
        const { confirmed, payload } = await this.popup.add(SelectionPopup, {
            title: _t("Change Unit of Measure"),
            list,
        });
        if (confirmed && payload && line.mubSetUom(payload)) {
            // Promotions depend on quantities: refresh them like a numpad change does.
            if (typeof order._updateRewards === "function") {
                order._updateRewards();
            }
        }
    }
}

ProductScreen.addControlButton({
    component: MubChangeUomButton,
    condition: function () {
        return this.pos.mubIsEnabled && this.pos.mubIsEnabled();
    },
});
