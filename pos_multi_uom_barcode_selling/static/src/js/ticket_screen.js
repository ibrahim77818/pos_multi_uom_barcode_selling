/** @odoo-module */

import { TicketScreen } from "@point_of_sale/app/screens/ticket_screen/ticket_screen";
import { patch } from "@web/core/utils/patch";

/** Refund lines keep the UoM (and the UoM price) of the refunded line. */
patch(TicketScreen.prototype, {
    _getToRefundDetail(orderline) {
        const detail = super._getToRefundDetail(...arguments);
        if (detail && detail.orderline && detail.orderline.mubUomId === undefined) {
            detail.orderline.mubUomId = orderline.mub_uom_id || false;
        }
        return detail;
    },

    _prepareRefundOrderlineOptions(toRefundDetail) {
        const options = super._prepareRefundOrderlineOptions(...arguments);
        const uomId = toRefundDetail.orderline && toRefundDetail.orderline.mubUomId;
        if (options && uomId) {
            options.extras = Object.assign({}, options.extras || {}, { mub_uom_id: uomId });
        }
        return options;
    },
});
