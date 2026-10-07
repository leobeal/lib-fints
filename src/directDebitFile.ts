/**
 * What the library needs to know about a pain.008 file to submit it, read from the
 * file itself. It is the caller's file and is sent byte for byte; nothing here
 * validates or rewrites it.
 */
export type DirectDebitFile = {
	/** The schema the file declares, e.g. `urn:iso:std:iso:20022:tech:xsd:pain.008.001.08`. */
	namespace: string;
	/** `B2B` goes to the bank as a different order than `CORE` and `COR1`. */
	scheme: 'CORE' | 'COR1' | 'B2B';
	/** The number of debits in the file. */
	count: number;
	/** The control sum of the group header, where the file states one. */
	total?: number;
};

export function readDirectDebitFile(xml: string): DirectDebitFile {
	const namespace = /xmlns="([^"]+)"/.exec(xml)?.[1];

	if (!namespace) {
		throw Error('the pain message does not declare its schema (xmlns)');
	}

	if (!namespace.includes('pain.008')) {
		throw Error(`a direct debit is a pain.008 message, this one declares ${namespace}`);
	}

	const scheme = /<PmtTpInf>[\s\S]*?<LclInstrm>[\s\S]*?<Cd>(CORE|COR1|B2B)<\/Cd>/.exec(xml)?.[1];

	if (!scheme) {
		throw Error('the pain message does not name its scheme (CORE, COR1 or B2B)');
	}

	const count = xml.split('<DrctDbtTxInf>').length - 1;

	if (count === 0) {
		throw Error('the pain message contains no direct debit');
	}

	const total = /<GrpHdr>[\s\S]*?<CtrlSum>([0-9.]+)<\/CtrlSum>[\s\S]*?<\/GrpHdr>/.exec(xml)?.[1];

	if (count > 1 && total === undefined) {
		throw Error('a pain message with several direct debits must state its control sum');
	}

	return {
		namespace,
		scheme: scheme as DirectDebitFile['scheme'],
		count,
		total: total === undefined ? undefined : Number.parseFloat(total),
	};
}
