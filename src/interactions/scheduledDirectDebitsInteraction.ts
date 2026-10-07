import { internationalAccount } from '../accountDescriptor.js';
import { type AccountRef, describeAccount } from '../bankAccount.js';
import type { FinTSConfig } from '../config.js';
import type { Message } from '../message.js';
import type { Segment } from '../segment.js';
import {
	HIDMB,
	type HIDMBSegment,
	HKDMB,
	type HKDMBSegment,
	type ScheduledDirectDebitsParameter,
} from '../segments/scheduledDirectDebits.js';
import { type ClientResponse, CustomerOrderInteraction } from './customerInteraction.js';

/** One collective direct debit order the bank holds for a later execution date. */
export type ScheduledDirectDebit = {
	/** The bank's id for the order. */
	orderId?: string;
	iban?: string;
	submitted?: Date;
	execution?: Date;
	/** Number of debits in the order. */
	count: number;
	total: number;
	currency: string;
};

export interface ScheduledDirectDebitsResponse extends ClientResponse {
	scheduledDirectDebits?: ScheduledDirectDebit[];
}

export class ScheduledDirectDebitsInteraction extends CustomerOrderInteraction {
	constructor(
		public account: AccountRef,
		public from?: Date,
		public to?: Date,
	) {
		super(HKDMB.Id, HIDMB.Id);
	}

	snapshot() {
		return {
			kind: 'scheduledDirectDebits',
			state: {
				account: this.account,
				from: this.from?.toISOString(),
				to: this.to?.toISOString(),
			},
		};
	}

	createSegments(init: FinTSConfig): Segment[] {
		const bankAccount = init.getBankAccount(this.account);
		if (!init.isAccountTransactionSupported(this.account, this.segId)) {
			throw Error(
				`Account ${describeAccount(this.account)} does not support business transaction '${this.segId}'`,
			);
		}

		const version = init.getMaxSupportedTransactionVersion(HKDMB.Id);
		if (!version) {
			throw Error(`There is no supported version for business transaction '${HKDMB.Id}`);
		}

		// A bank that does not take a period is asked for everything it holds.
		const parameter = init.getTransactionParameters<ScheduledDirectDebitsParameter>(HKDMB.Id);
		const ranged = parameter?.dateRangeAllowed !== false;

		const hkdmb: HKDMBSegment = {
			header: { segId: HKDMB.Id, segNr: 0, version },
			account: internationalAccount(init, bankAccount),
			from: ranged ? this.from : undefined,
			to: ranged ? this.to : undefined,
		};

		return [hkdmb];
	}

	handleResponse(response: Message, clientResponse: ScheduledDirectDebitsResponse) {
		const held = response.findAllSegments<HIDMBSegment>(HIDMB.Id);
		clientResponse.scheduledDirectDebits = [
			...(clientResponse.scheduledDirectDebits ?? []),
			...held.map((order) => ({
				orderId: order.orderId,
				iban: order.account?.iban,
				submitted: order.submitted,
				execution: order.execution,
				count: order.count,
				total: order.total.value,
				currency: order.total.currency,
			})),
		];
	}
}
