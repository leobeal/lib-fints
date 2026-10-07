import { AlphaNumeric } from '../dataElements/AlphaNumeric.js';
import { Binary } from '../dataElements/Binary.js';
import type { DataElement } from '../dataElements/DataElement.js';
import { Numeric } from '../dataElements/Numeric.js';
import { YesNo } from '../dataElements/YesNo.js';
import {
	type InternationalAccount,
	InternationalAccountGroup,
} from '../dataGroups/InternationalAccount.js';
import { type Money, MoneyGroup } from '../dataGroups/Money.js';
import type { Segment } from '../segment.js';
import { SegmentDefinition } from '../segmentDefinition.js';
import {
	BusinessTransactionParameter,
	type BusinessTransactionParameterSegment,
} from './businessTransactionParameter.js';

/**
 * Submitting SEPA direct debits (FinTS 3.0 Messages, Geschäftsvorfälle, C.10.2.5 and
 * C.10.3.2). Four orders share two layouts:
 *
 *              one debit    several debits
 *   CORE/COR1  HKDSE        HKDME
 *   B2B        HKBSE        HKBME
 *
 * The collective forms add a total and the wish for one booking per debit; apart
 * from that every one of them is an account, the name of a pain.008 schema and the
 * pain.008 file itself.
 */

export type DirectDebitSegment = Segment & {
	account: InternationalAccount;
	/** Collective orders only: the control sum of the file. */
	total?: Money;
	/** Collective orders only, and only where the bank allows the choice. */
	singleBooking?: boolean;
	sepaDescriptor: string;
	/** The pain.008 file as a binary string, one character per byte. */
	painMessage: string;
};

const single = () => [
	new InternationalAccountGroup('account', 1, 1),
	new AlphaNumeric('sepaDescriptor', 1, 1, 256),
	new Binary('painMessage', 1, 1),
];

const collective = () => [
	new InternationalAccountGroup('account', 1, 1),
	new MoneyGroup('total', 0, 1),
	new YesNo('singleBooking', 0, 1),
	new AlphaNumeric('sepaDescriptor', 1, 1, 256),
	new Binary('painMessage', 1, 1),
];

abstract class DirectDebitOrder extends SegmentDefinition {
	version = 2;
	elements: DataElement[];

	constructor(id: string, elements: DataElement[]) {
		super(id);
		this.elements = elements;
	}
}

export class HKDSE extends DirectDebitOrder {
	static Id = 'HKDSE';
	constructor() {
		super(HKDSE.Id, single());
	}
}

export class HKDME extends DirectDebitOrder {
	static Id = 'HKDME';
	constructor() {
		super(HKDME.Id, collective());
	}
}

export class HKBSE extends DirectDebitOrder {
	static Id = 'HKBSE';
	constructor() {
		super(HKBSE.Id, single());
	}
}

export class HKBME extends DirectDebitOrder {
	static Id = 'HKBME';
	constructor() {
		super(HKBME.Id, collective());
	}
}

/**
 * What a bank announces about one of the four orders. Version 1 states the lead
 * times as four numbers, version 2 as two coded strings followed by the pain
 * schemas it takes; the collective orders put their three fields in between.
 *
 * Every field is optional here although the specification requires most of them.
 * These segments arrive with the bank parameters at every login, a message is
 * decoded as a whole, and a bank that leaves a field out would otherwise lose its
 * customers the login over an order they may never send.
 */
export type DirectDebitParameter = {
	maxDebits?: number;
	totalRequired?: boolean;
	singleBookingAllowed?: boolean;
	supportedSepaFormats?: string[];
};

export type DirectDebitParameterSegment = BusinessTransactionParameterSegment<DirectDebitParameter>;

const leadTimes = () => [
	new Numeric('minLeadTimeFnalRcur', 0, 1, 4, 1, 1),
	new Numeric('maxLeadTimeFnalRcur', 0, 1, 4, 1, 1),
	new Numeric('minLeadTimeFrstOoff', 0, 1, 4, 1, 1),
	new Numeric('maxLeadTimeFrstOoff', 0, 1, 4, 1, 1),
	new AlphaNumeric('minLeadTimeCoded', 0, 1, 99, 2),
	new AlphaNumeric('maxLeadTimeCoded', 0, 1, 99, 2),
];

const formats = () => [
	new AlphaNumeric('purposeCodes', 0, 1, 4096, 2),
	new AlphaNumeric('supportedSepaFormats', 0, 99, 256, 2),
];

const singleParameters = () => [...leadTimes(), ...formats()];

const collectiveParameters = () => [
	...leadTimes(),
	new Numeric('maxDebits', 0, 1, 7),
	new YesNo('totalRequired', 0, 1),
	new YesNo('singleBookingAllowed', 0, 1),
	...formats(),
];

abstract class DirectDebitParameters extends BusinessTransactionParameter {
	version = 2;
}

export class HIDSES extends DirectDebitParameters {
	static Id = 'HIDSES';
	constructor() {
		super(HIDSES.Id, singleParameters());
	}
}

export class HIDMES extends DirectDebitParameters {
	static Id = 'HIDMES';
	constructor() {
		super(HIDMES.Id, collectiveParameters());
	}
}

export class HIBSES extends DirectDebitParameters {
	static Id = 'HIBSES';
	constructor() {
		super(HIBSES.Id, singleParameters());
	}
}

export class HIBMES extends DirectDebitParameters {
	static Id = 'HIBMES';
	constructor() {
		super(HIBMES.Id, collectiveParameters());
	}
}
