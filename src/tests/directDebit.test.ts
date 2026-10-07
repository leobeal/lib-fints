import { describe, expect, it } from 'vitest';
import type { BankingInformation } from '../bankingInformation.js';
import type { BPD } from '../bpd.js';
import { FinTSConfig } from '../config.js';
import { readDirectDebitFile } from '../directDebitFile.js';
import {
	DirectDebitInteraction,
	directDebitOrder,
} from '../interactions/directDebitInteraction.js';
import { decode, encode } from '../segment.js';
import type { DirectDebitParameterSegment, DirectDebitSegment } from '../segments/directDebit.js';
import { registerSegments } from '../segments/registry.js';

registerSegments();

const PAIN_02 = 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.02';

function pain(names: string[], scheme = 'CORE', namespace = PAIN_02, withTotal = true) {
	const debits = names
		.map(
			(name) =>
				`<DrctDbtTxInf><InstdAmt Ccy="EUR">10.00</InstdAmt><Dbtr><Nm>${name}</Nm></Dbtr></DrctDbtTxInf>`,
		)
		.join('');
	const total = withTotal ? `<CtrlSum>${(names.length * 10).toFixed(2)}</CtrlSum>` : '';

	return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${namespace}"><CstmrDrctDbtInitn><GrpHdr><NbOfTxs>${names.length}</NbOfTxs>${total}</GrpHdr><PmtInf><PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl><LclInstrm><Cd>${scheme}</Cd></LclInstrm></PmtTpInf>${debits}</PmtInf></CstmrDrctDbtInitn></Document>`;
}

function configWith(
	transactions: Record<string, { versions?: number[]; params?: unknown }>,
	sepaFormats?: string[],
) {
	const bankingInformation: BankingInformation = {
		systemId: 'SYSTEM',
		bankMessages: [],
		bpd: {
			version: 1,
			bankId: '12345678',
			bankName: 'Testbank',
			countryCode: 280,
			url: 'https://bank.example/fints',
			maxTransactionsPerMessage: 1,
			supportedLanguages: [],
			supportedHbciVersions: [300],
			supportedTanMethods: [],
			availableTanMethodIds: [],
			allowedTransactions: [
				{
					transId: 'HKSPA',
					tanRequired: false,
					versions: [1],
					params: { nationalAccountAllowed: false, supportedSepaFormats: sepaFormats },
				},
				...Object.entries(transactions).map(([transId, t]) => ({
					transId,
					tanRequired: true,
					versions: t.versions ?? [1],
					params: t.params,
				})),
			],
		} as BPD,
		upd: {
			version: 1,
			usage: 0,
			bankAccounts: [
				{
					accountNumber: '1000000001',
					bank: { country: 280, bankId: '12345678' },
					iban: 'DE89370400440532013000',
					bic: 'TESTDE8LXXX',
				},
			],
		} as BankingInformation['upd'],
	};

	return FinTSConfig.fromBankingInformation('PRODUCT', '1.0', bankingInformation, 'user', 'pin');
}

describe('readDirectDebitFile', () => {
	it('reads schema, scheme, count and control sum', () => {
		expect(readDirectDebitFile(pain(['A', 'B'], 'COR1'))).toEqual({
			namespace: PAIN_02,
			scheme: 'COR1',
			count: 2,
			total: 20,
		});
	});

	it('takes a single debit without a control sum, but not several', () => {
		expect(readDirectDebitFile(pain(['A'], 'CORE', PAIN_02, false)).total).toBeUndefined();
		expect(() => readDirectDebitFile(pain(['A', 'B'], 'CORE', PAIN_02, false))).toThrow(
			'control sum',
		);
	});

	it('refuses what is not a direct debit file', () => {
		expect(() => readDirectDebitFile('<Document/>')).toThrow('schema');
		expect(() =>
			readDirectDebitFile(pain(['A'], 'CORE', 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03')),
		).toThrow('pain.008');
		expect(() => readDirectDebitFile(pain(['A'], 'INST'))).toThrow('scheme');
		expect(() => readDirectDebitFile(pain([]))).toThrow('no direct debit');
	});
});

describe('directDebitOrder', () => {
	const both = configWith({ HKDSE: {}, HKDME: {}, HKBSE: {}, HKBME: {} });

	it('sends several debits as a collective order', () => {
		expect(directDebitOrder(both, readDirectDebitFile(pain(['A', 'B'])))).toBe('HKDME');
		expect(directDebitOrder(both, readDirectDebitFile(pain(['A', 'B'], 'B2B')))).toBe('HKBME');
	});

	it('sends one debit as a single order unless asked otherwise', () => {
		const one = readDirectDebitFile(pain(['A']));

		expect(directDebitOrder(both, one)).toBe('HKDSE');
		expect(directDebitOrder(both, one, true)).toBe('HKDME');
		expect(directDebitOrder(both, readDirectDebitFile(pain(['A'], 'B2B')), true)).toBe('HKBME');
	});

	it('keeps one debit single when the file has no control sum or the bank no collective order', () => {
		expect(
			directDebitOrder(both, readDirectDebitFile(pain(['A'], 'CORE', PAIN_02, false)), true),
		).toBe('HKDSE');
		expect(
			directDebitOrder(configWith({ HKDSE: {} }), readDirectDebitFile(pain(['A'])), true),
		).toBe('HKDSE');
	});

	it('falls back to the collective order at a bank without a single one', () => {
		expect(directDebitOrder(configWith({ HKDME: {} }), readDirectDebitFile(pain(['A'])))).toBe(
			'HKDME',
		);
	});
});

describe('DirectDebitInteraction', () => {
	it('builds a collective order with the total and the file as UTF-8 bytes', () => {
		const xml = pain(['Jürgen Größe', 'Anna Schmidt']);
		const config = configWith({ HKDME: { params: { singleBookingAllowed: true } } });
		const [segment] = new DirectDebitInteraction('1000000001', xml, 'HKDME').getSegments(
			config,
		) as DirectDebitSegment[];

		expect(segment.header).toEqual({ segId: 'HKDME', segNr: 0, version: 1 });
		expect(segment.account).toEqual({ iban: 'DE89370400440532013000', bic: 'TESTDE8LXXX' });
		expect(segment.total).toEqual({ value: 20, currency: 'EUR' });
		expect(segment.singleBooking).toBe(false);
		expect(segment.sepaDescriptor).toBe(PAIN_02);

		const bytes = Buffer.byteLength(xml, 'utf8');
		expect(segment.painMessage.length).toBe(bytes);

		segment.header.segNr = 3;
		expect(encode(segment)).toBe(
			`HKDME:3:1+DE89370400440532013000:TESTDE8LXXX+20,:EUR+N+urn?:iso?:std?:iso?:20022?:tech?:xsd?:pain.008.001.02+@${bytes}@${segment.painMessage}'`,
		);
	});

	it('leaves the booking wish out where the bank gives no choice', () => {
		const config = configWith({ HKDME: { params: { singleBookingAllowed: false } } });
		const [segment] = new DirectDebitInteraction(
			'1000000001',
			pain(['A', 'B']),
			'HKDME',
		).getSegments(config) as DirectDebitSegment[];

		expect(segment.singleBooking).toBeUndefined();
	});

	it('builds a single order without total', () => {
		const xml = pain(['A']);
		const config = configWith({ HKDSE: { versions: [1, 2] } });
		const [segment] = new DirectDebitInteraction('1000000001', xml, 'HKDSE').getSegments(
			config,
		) as DirectDebitSegment[];

		segment.header.segNr = 3;
		expect(encode(segment)).toBe(
			`HKDSE:3:2+DE89370400440532013000:TESTDE8LXXX+urn?:iso?:std?:iso?:20022?:tech?:xsd?:pain.008.001.02+@${xml.length}@${xml}'`,
		);
	});

	it('refuses a schema the bank does not list, naming the ones it does', () => {
		const config = configWith({
			HKDME: { params: { supportedSepaFormats: ['sepade:xsd:pain.008.003.02.xsd'] } },
		});

		expect(() =>
			new DirectDebitInteraction('1000000001', pain(['A', 'B']), 'HKDME').getSegments(config),
		).toThrow('only urn:iso:std:iso:20022:tech:xsd:pain.008.003.02');
	});

	it('accepts a schema the bank lists with a GBIC suffix, or in its general SEPA parameters', () => {
		const own = configWith({
			HKDME: { params: { supportedSepaFormats: [`${PAIN_02}_GBIC_3`] } },
		});
		const general = configWith({ HKDME: {} }, [PAIN_02]);
		const silent = configWith({ HKDME: {} });

		for (const config of [own, general, silent]) {
			expect(
				new DirectDebitInteraction('1000000001', pain(['A', 'B']), 'HKDME').getSegments(config),
			).toHaveLength(1);
		}
	});
});

describe('direct debit parameters', () => {
	it('reads version 1 of the collective order', () => {
		const segment = decode(
			"HIDMES:20:1:4+1+1+0+1:999:1:999:100:N:J'",
		) as DirectDebitParameterSegment;

		expect(segment.params.maxDebits).toBe(100);
		expect(segment.params.totalRequired).toBe(false);
		expect(segment.params.singleBookingAllowed).toBe(true);
	});

	// Laid out after the specification (C.10.3.2.2, segment version 2); not a capture.
	it('reads version 2 with its coded lead times and schemas', () => {
		const segment = decode(
			"HIDMES:21:2:4+1+1+1+1;1;2;235959:1;1;99;235959:9999:J:N::urn?:iso?:std?:iso?:20022?:tech?:xsd?:pain.008.001.02:urn?:iso?:std?:iso?:20022?:tech?:xsd?:pain.008.001.08'",
		) as DirectDebitParameterSegment;

		expect(segment.params.maxDebits).toBe(9999);
		expect(segment.params.totalRequired).toBe(true);
		expect(segment.params.singleBookingAllowed).toBe(false);
		expect(segment.params.supportedSepaFormats).toEqual([
			PAIN_02,
			'urn:iso:std:iso:20022:tech:xsd:pain.008.001.08',
		]);
	});

	it('reads the single order in both versions', () => {
		expect(
			(decode("HIDSES:22:1:4+1+1+0+1:999:1:999'") as DirectDebitParameterSegment).header.segId,
		).toBe('HIDSES');

		const v2 = decode(
			"HIBSES:23:2:4+1+1+1+2;1;235959:2;99;235959::sepade?:xsd?:pain.008.001.02.xsd'",
		) as DirectDebitParameterSegment;
		expect(v2.params.supportedSepaFormats).toEqual(['sepade:xsd:pain.008.001.02.xsd']);
	});
});
