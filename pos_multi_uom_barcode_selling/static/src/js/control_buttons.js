import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { SelectionPopup } from "@point_of_sale/app/components/popups/selection_popup/selection_popup";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { AlertDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { _t } from "@web/core/l10n/translation";
import { patch } from "@web/core/utils/patch";

patch(ControlButtons.prototype, {
    get mubShowChangeUom() {
        return Boolean(this.pos.mubIsEnabled && this.pos.mubIsEnabled());
    },

    async clickMubChangeUom() {
        const order = this.pos.getOrder();
        const line = order && order.getSelectedOrderline();
        if (!line) {
            this.dialog.add(AlertDialog, {
                title: _t("No order line selected"),
                body: _t("Select an order line first, then use Change UoM."),
            });
            return;
        }
        if (line.is_reward_line || line.refunded_orderline_id || line.combo_parent_id ||
                (line.combo_line_ids && line.combo_line_ids.length)) {
            this.dialog.add(AlertDialog, {
                title: _t("Unit of measure cannot be changed"),
                body: _t("Reward lines and refund lines keep the unit of measure they were created with."),
            });
            return;
        }
        const product = line.product_id;
        const uomIds = this.pos.mubGetProductUomIds(product);
        if (uomIds.length < 2) {
            this.dialog.add(AlertDialog, {
                title: _t("No secondary units of measure"),
                body: _t("%s has no secondary unit of measure with a UoM barcode.", line.getFullProductName()),
            });
            return;
        }
        const mainId = product.uom_id.id;
        const current = line.getUnit();
        const currentId = current ? current.id : mainId;
        // The current unit is marked in the label instead of the popup's
        // "selected" state, which is hard to read.
        const list = uomIds.map((id) => {
            const uom = this.pos.models["uom.uom"].get(id);
            const tags = [];
            if (id === mainId) {
                tags.push(_t("main unit"));
            }
            if (id === currentId) {
                tags.push(_t("current"));
            }
            return {
                id,
                item: uom,
                isSelected: false,
                // Plain concatenation: the JS minifier can strip spaces in template literals.
                label: (id === currentId ? "✓ " : "") + uom.name +
                    (tags.length ? " (" + tags.join(", ") + ")" : ""),
            };
        });
        const uom = await makeAwaitable(this.dialog, SelectionPopup, {
            title: _t("Change Unit of Measure"),
            list,
        });
        if (uom && line.mubSetUom(uom)) {
            // Promotions depend on quantities: refresh them like a numpad change does.
            if (typeof this.pos.updateRewards === "function") {
                this.pos.updateRewards();
            }
        }
    },
});
