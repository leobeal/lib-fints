import { internationalAccount } from '../accountDescriptor.js';
import type { AccountRef } from '../bankAccount.js';
import { utf8ToBinary } from '../bytes.js';
import type { FinTSConfig } from '../config.js';
import { type DirectDebitFile, readDirectDebitFile } from '../directDebitFile.js';
import type { Message } from '../message.js';
import type { Segment } from '../segment.js';
import {
	type DirectDebitParameter,
	type DirectDebitSegment,
	HKBME,
	HKBSE,
	HKDME,
	HKDSE,
} from '../segments/directDebit.js';
import type { HISPASParameter } from '../segments/HISPAS.js';
import { HKSPA } from '../segments/HKSPA.js';
import { type ClientResponse, CustomerOrderInteraction } from './customerInteraction.js';

/**
 * The answer to a submitted direct debit file. There is nothing to read from it:
 * `success` without `requiresTan` means the bank accepted the file, and the
 * `bankAnswers` say so in the bank's words.
 */
export interface DirectDebitResponse extends ClientResponse {}

/**
 * The order a file goes out as. A file with one debit is a single order — unless
 * the bank offers no single order, or `collective` is asked for and the file has
 * the control sum a collective order carries.
 */
export function directDebitOrder(
	config: FinTSConfig,
	file: DirectDebitFile,
	collective = false,
): string {
	const [singleId, collectiveId] =
		file.scheme === 'B2B' ? [HKBSE.Id, HKBME.Id] : [HKDSE.Id, HKDME.Id];

	if (file.count > 1) {
		return collectiveId;
	}

	const canGoCollective = file.total !== undefined && config.isTransactionSupported(collectiveId);

	if (canGoCollective && (collective || !config.isTransactionSupported(singleId))) {
		return collectiveId;
	}

	return singleId;
}

/**
 * Banks name the schemas they take in several spellings: the plain URN, the URN
 * with a `_GBIC_n` suffix, or the old `sepade:xsd:pain.008.001.02.xsd` form.
 */
function normalizeFormat(format: string): string {
	return format
		.replace('sepade:xsd:', 'urn:iso:std:iso:20022:tech:xsd:')
		.replace('sepade:', 'urn:iso:std:iso:20022:tech:xsd:')
		.replace('.xsd', '');
}

export class DirectDebitInteraction extends CustomerOrderInteraction {
	readonly file: DirectDebitFile;

	/**
	 * @param account the creditor's account the debits are collected on
	 * @param painXml the pain.008 file, sent as it is
	 * @param orderId the order to submit it as, see `directDebitOrder`
	 */
	constructor(
		public account: AccountRef,
		public painXml: string,
		orderId: string,
	) {
		super(orderId, 'HIRMS');
		this.file = readDirectDebitFile(painXml);
	}

	/** Carries the file: keep the snapshot as carefully as the file itself. */
	snapshot() {
		return {
			kind: 'directDebit',
			state: { account: this.account, painXml: this.painXml, orderId: this.segId },
		};
	}

	createSegments(config: FinTSConfig): Segment[] {
		const bankAccount = config.getBankAccount(this.account);
		const version = config.getMaxSupportedTransactionVersion(this.segId);

		if (!version) {
			throw Error(`There is no supported version for business transaction '${this.segId}'`);
		}

		const params = config.getTransactionParameters<DirectDebitParameter>(this.segId);

		this.assertFormatSupported(config, params);

		const segment: DirectDebitSegment = {
			header: { segId: this.segId, segNr: 0, version },
			account: internationalAccount(config, bankAccount),
			sepaDescriptor: this.file.namespace,
			painMessage: utf8ToBinary(this.painXml),
		};

		if (this.segId === HKDME.Id || this.segId === HKBME.Id) {
			if (this.file.total === undefined) {
				throw Error('a collective direct debit needs the control sum of the pain message');
			}

			segment.total = { value: this.file.total, currency: 'EUR' };

			if (params?.singleBookingAllowed) {
				segment.singleBooking = false;
			}
		}

		return [segment];
	}

	handleResponse(_response: Message, _clientResponse: ClientResponse) {
		// The bank answers with return codes only.
	}

	/**
	 * A file in a schema the bank does not take is refused before it is sent, with the
	 * schemas the bank does take in the message. The order's own parameters decide; a
	 * bank that lists none there has them in its general SEPA parameters, and one that
	 * lists none at all is left to judge the file itself.
	 */
	private assertFormatSupported(config: FinTSConfig, params?: DirectDebitParameter) {
		const own = params?.supportedSepaFormats?.filter((format) => !!format) ?? [];
		const general =
			config
				.getTransactionParameters<HISPASParameter>(HKSPA.Id)
				?.supportedSepaFormats?.filter((format) => !!format) ?? [];
		const supported = (own.length > 0 ? own : general).map(normalizeFormat);

		if (
			supported.length > 0 &&
			!supported.some((format) => format.startsWith(this.file.namespace))
		) {
			throw Error(
				`The bank does not support the schema ${this.file.namespace}, only ${supported.join(', ')}`,
			);
		}
	}
}
