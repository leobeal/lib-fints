import { internationalAccount } from '../accountDescriptor.js';
import type { AccountRef } from '../bankAccount.js';
import { binaryToUtf8 } from '../bytes.js';
import { CamtParser } from '../camtParser.js';
import type { FinTSConfig } from '../config.js';
import type { Message } from '../message.js';
import type { Segment } from '../segment.js';
import { HICAZ, type HICAZSegment } from '../segments/HICAZ.js';
import type { HICAZSParameter } from '../segments/HICAZS.js';
import { HKCAZ, type HKCAZSegment } from '../segments/HKCAZ.js';
import type { Statement } from '../statement.js';
import { CustomerOrderInteraction, type StatementResponse } from './customerInteraction.js';

export class StatementInteractionCAMT extends CustomerOrderInteraction {
	constructor(
		public account: AccountRef,
		public from?: Date,
		public to?: Date,
	) {
		super(HKCAZ.Id, HICAZ.Id);
	}

	createSegments(init: FinTSConfig): Segment[] {
		const bankAccount = init.getBankAccount(this.account);
		const version = init.getMaxSupportedTransactionVersion(HKCAZ.Id);
		if (!version) {
			throw Error(`There is no supported version for business transaction '${HKCAZ.Id}'`);
		}

		let acceptedCamtFormats = ['urn:iso:std:iso:20022:tech:xsd:camt.052.001.08'];

		const params = init.getTransactionParameters<HICAZSParameter>(HKCAZ.Id);

		if (params && params.supportedCamtFormats.length > 0) {
			acceptedCamtFormats = params.supportedCamtFormats.filter((format) =>
				format.startsWith('urn:iso:std:iso:20022:tech:xsd:camt.052.001.'),
			);
		}

		const hkcaz: HKCAZSegment = {
			header: { segId: HKCAZ.Id, segNr: 0, version: version },
			account: internationalAccount(init, bankAccount),
			acceptedCamtFormats: acceptedCamtFormats,
			allAccounts: false,
			from: this.from,
			to: this.to,
		};

		return [hkcaz];
	}

	handleResponse(response: Message, clientResponse: StatementResponse) {
		// A response the bank spread over several messages arrives as several HICAZ
		// segments, each carrying its own share of the CAMT documents. Taking only the
		// first one would silently drop everything after it.
		const camtMessages = response
			.findAllSegments<HICAZSegment>(HICAZ.Id)
			.flatMap((segment) => segment.bookedTransactions ?? []);

		clientResponse.format = 'camt';
		clientResponse.documents = [];

		if (camtMessages.length > 0) {
			try {
				// Parse all CAMT messages (one per booking day) and combine statements
				const allStatements: Statement[] = [];
				for (const camtMessage of camtMessages) {
					// The regex looks for the XML declaration `<?xml ... ?>`
					// and checks if it contains the attribute encoding="UTF-8".
					// The 'i' flag makes the match case-insensitive (e.g., for "utf-8").
					const isUtf8Encoded = /<\?xml[^>]*encoding="UTF-8"[^>]*\?>/i.test(camtMessage);

					let xmlString: string = camtMessage;
					if (isUtf8Encoded) {
						// The parser keeps one character per byte, so a UTF-8 document arrives
						// with every multi-byte character split up.
						xmlString = binaryToUtf8(camtMessage);
					}

					// Kept before parsing: a document this library cannot read is still the
					// bank's answer, and the caller may have a parser that can.
					clientResponse.documents.push(xmlString);

					const parser = new CamtParser(xmlString);
					const statements = parser.parse();
					allStatements.push(...statements);
				}
				clientResponse.statements = allStatements;
			} catch (error) {
				console.warn('CAMT parsing failed:', error);
				clientResponse.statements = [];
			}
		} else {
			clientResponse.statements = [];
		}
	}
}
