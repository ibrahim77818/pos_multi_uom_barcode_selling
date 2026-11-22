odoo.define('pos_multi_uom_barcode_selling.TicketScreen', function (require) {
    'use strict';

    const TicketScreen = require('point_of_sale.TicketScreen');
    const Registries = require('point_of_sale.Registries');

    /** Refund lines keep the UoM (and the UoM price) of the refunded line. */
    const MubTicketScreen = (TicketScreen) => class MubTicketScreen extends TicketScreen {
        _getToRefundDetail(orderline) {
            const detail = super._getToRefundDetail(...arguments);
            if (detail && detail.orderline && detail.orderline.mubUomId === undefined) {
                detail.orderline.mubUomId = orderline.mub_uom_id || false;
            }
            return detail;
        }

        _prepareRefundOrderlineOptions(toRefundDetail) {
            const options = super._prepareRefundOrderlineOptions(...arguments);
            const uomId = toRefundDetail.orderline && toRefundDetail.orderline.mubUomId;
            if (options && uomId) {
                options.extras = Object.assign({}, options.extras || {}, { mub_uom_id: uomId });
            }
            return options;
        }
    };
    Registries.Component.extend(TicketScreen, MubTicketScreen);

    return MubTicketScreen;
});
