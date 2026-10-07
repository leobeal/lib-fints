import { AlphaNumeric } from '../dataElements/AlphaNumeric.js';
import { Dat } from '../dataElements/Dat.js';
import { Numeric } from '../dataElements/Numeric.js';
import { YesNo } from '../dataElements/YesNo.js';
import {
	type InternationalAccount,
	InternationalAccountGroup,
} from '../dataGroups/InternationalAccount.js';
import { type Money, MoneyGroup } from '../dataGroups/Money.js';
import type { Segment, SegmentWithContinuationMark } from '../segment.js';
import { SegmentDefinition } from '../segmentDefinition.js';
import {
	BusinessTransactionParameter,
	type BusinessTransactionParameterSegment,
} from './businessTransactionParameter.js';

/**
 * The collective SEPA direct debits a bank holds for a later execution date
 * (FinTS 3.0 Messages, Geschäftsvorfälle: "Bestand terminierter
 * SEPA-Sammellastschriften"). The bank answers with one HIDMB per order it holds:
 * its own id for it, when it was submitted, when it will be executed, and how many
 * debits over which total it contains.
 */
export type HKDMBSegment = SegmentWithContinuationMark & {
	account: InternationalAccount;
	from?: Date;
	to?: Date;
	maxEntries?: number;
};

export class HKDMB extends SegmentDefinition {
	static Id = 'HKDMB';
	version = 1;
	constructor() {
		super(HKDMB.Id);
	}
	elements = [
		new InternationalAccountGroup('account', 1, 1),
		new Dat('from', 0, 1),
		new Dat('to', 0, 1),
		new Numeric('maxEntries', 0, 1, 4),
		new AlphaNumeric('continuationMark', 0, 1, 35),
	];
}

export type HIDMBSegment = Segment & {
	orderId?: string;
	account: InternationalAccount;
	submitted?: Date;
	execution?: Date;
	count: number;
	total: Money;
};

export class HIDMB extends SegmentDefinition {
	static Id = 'HIDMB';
	version = 1;
	constructor() {
		super(HIDMB.Id);
	}
	elements = [
		new AlphaNumeric('orderId', 0, 1, 99),
		new InternationalAccountGroup('account', 1, 1),
		new Dat('submitted', 0, 1),
		new Dat('execution', 0, 1),
		new Numeric('count', 1, 1, 6),
		new MoneyGroup('total', 1, 1),
	];
}

export type ScheduledDirectDebitsParameter = {
	maxEntriesAllowed?: boolean;
	dateRangeAllowed?: boolean;
};

export type HIDMBSSegment = BusinessTransactionParameterSegment<ScheduledDirectDebitsParameter>;

/** Optional throughout, for the reason given at the direct debit parameters. */
export class HIDMBS extends BusinessTransactionParameter {
	static Id = 'HIDMBS';
	version = 1;
	constructor() {
		super(HIDMBS.Id, [new YesNo('maxEntriesAllowed', 0, 1), new YesNo('dateRangeAllowed', 0, 1)]);
	}
}
