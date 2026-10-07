import { BankExchangeError } from './bankExchangeError.js';
import { TanMediaRequirement, TanProcess } from './codes.js';
import type { FinTSConfig } from './config.js';
import { HttpClient } from './httpClient.js';
import {
	type ClientResponse,
	type CustomerInteraction,
	CustomerOrderInteraction,
	type InteractionSnapshot,
} from './interactions/customerInteraction.js';
import { EndDialogInteraction } from './interactions/endDialogInteraction.js';
import { InitDialogInteraction } from './interactions/initDialogInteraction.js';
import { restoreInteraction } from './interactions/restore.js';
import { CustomerMessage, CustomerOrderMessage, type Message } from './message.js';
import { PARTED, type PartedSegment } from './partedSegment.js';
import type { SegmentWithContinuationMark } from './segment.js';
import { decode } from './segment.js';
import { HKEND } from './segments/HKEND.js';
import { HKTAN, type HKTANSegment } from './segments/HKTAN.js';
import { HNHBK, type HNHBKSegment } from './segments/HNHBK.js';

/**
 * A dialog put away: enough to take it up again in another process, as plain data
 * that survives JSON.
 *
 * It holds no PIN — that comes with the configuration the dialog is restored with —
 * but it does hold what the waiting interactions carry, a direct debit file
 * included.
 */
export type DialogSnapshot = {
	dialogId: string;
	lastMessageNumber: number;
	isInitialized: boolean;
	keepOpen: boolean;
	/** The interaction the bank waits on, then those queued behind it. Empty when nothing waits. */
	pending: InteractionSnapshot[];
	/** What to continue the waiting interaction with. */
	tanReference?: string;
};

export class Dialog {
	dialogId: string = '0';
	lastMessageNumber = 0;
	interactions: CustomerInteraction[] = [];
	responses: Map<string, ClientResponse> = new Map();
	currentInteractionIndex = 0;
	isInitialized = false;
	/** The current interaction was sent and the bank waits for a TAN or an approval. */
	isWaiting = false;
	hasEnded = false;
	httpClient: HttpClient;

	/**
	 * @param keepOpen leaves the dialog open once its interactions are through, so that
	 * further ones can follow with `run()`; it then lasts until `end()`. Without it the
	 * dialog ends itself after the last interaction.
	 */
	constructor(
		public config: FinTSConfig,
		syncSystemId: boolean = false,
		public keepOpen: boolean = false,
	) {
		if (!this.config) {
			throw new Error('configuration must be provided');
		}

		this.httpClient = this.getHttpClient();
		this.interactions.push(new InitDialogInteraction(this.config, syncSystemId));

		if (!keepOpen) {
			this.interactions.push(new EndDialogInteraction());
		}
		this.interactions.forEach((interaction) => {
			interaction.dialog = this;
		});
	}

	get currentInteraction(): CustomerInteraction {
		return this.interactions[this.currentInteractionIndex];
	}

	async start(): Promise<Map<string, ClientResponse>> {
		if (this.isInitialized) {
			throw new Error('dialog has already been initialized');
		}

		if (this.hasEnded) {
			throw Error('cannot start a dialog that has already ended');
		}

		if (this.lastMessageNumber > 0) {
			throw new Error('dialog start can only be called on a new dialog');
		}

		return await this.advance();
	}

	async continue(tanOrderReference: string, tan?: string): Promise<Map<string, ClientResponse>> {
		if (!tanOrderReference) {
			throw Error('tanOrderReference must be provided to continue a customer order with a TAN');
		}

		if (!this.config.selectedTanMethod?.isDecoupled && !tan) {
			throw Error('TAN must be provided for non-decoupled TAN methods');
		}

		if (this.hasEnded) {
			throw Error('cannot continue a customer order when dialog has already ended');
		}

		if (!this.currentInteraction) {
			throw new Error('there is no running customer interaction in this dialog to continue');
		}

		return await this.advance(this.createCurrentTanMessage(tanOrderReference, tan));
	}

	/**
	 * Carries out a further interaction in a dialog that was kept open.
	 */
	async run(interaction: CustomerInteraction): Promise<Map<string, ClientResponse>> {
		if (!this.isOpen) {
			throw Error('an interaction can only be run in an open dialog');
		}

		if (this.isWaiting) {
			throw Error('the dialog still waits for a TAN or an approval for its current interaction');
		}

		// An interaction the bank refused stays current; it is not sent again.
		this.interactions.length = this.currentInteractionIndex;

		this.addCustomerInteraction(interaction);
		return await this.advance();
	}

	/**
	 * Ends a dialog that was kept open. An interaction still waiting for a TAN is
	 * given up with it.
	 */
	async end(): Promise<void> {
		// A dialog the bank never opened has nothing to end.
		if (this.hasEnded || this.dialogId === '0') {
			this.hasEnded = true;
			return;
		}

		const end = new EndDialogInteraction();
		end.dialog = this;
		this.interactions = [...this.interactions.slice(0, this.currentInteractionIndex), end];
		await this.advance();
		this.hasEnded = true;
	}

	/**
	 * The dialog as plain data, to be taken up again with `Dialog.restore()` — by a
	 * process that was stopped while the customer approved an order elsewhere.
	 */
	snapshot(): DialogSnapshot {
		if (this.hasEnded) {
			throw Error('a dialog that has ended cannot be taken up again');
		}

		if (!this.isWaiting && !(this.keepOpen && this.isInitialized)) {
			throw Error('the dialog neither waits for an approval nor is it open');
		}

		const pending = this.isWaiting
			? this.interactions
					.slice(this.currentInteractionIndex)
					.filter((interaction) => !(interaction instanceof EndDialogInteraction))
					.map((interaction) => {
						const snapshot = interaction.snapshot();

						if (!snapshot) {
							throw Error(`the interaction ${interaction.segId} cannot be taken up again`);
						}

						return snapshot;
					})
			: [];

		return {
			dialogId: this.dialogId,
			lastMessageNumber: this.lastMessageNumber,
			isInitialized: this.isInitialized,
			keepOpen: this.keepOpen,
			pending,
			tanReference: this.isWaiting
				? this.responses.get(this.currentInteraction.segId)?.tanReference
				: undefined,
		};
	}

	/**
	 * Takes a dialog up again. The configuration has to be the one it was started
	 * with: same bank, same user, same system id, same TAN method.
	 */
	static restore(config: FinTSConfig, snapshot: DialogSnapshot): Dialog {
		const dialog = new Dialog(config, false, true);

		dialog.keepOpen = snapshot.keepOpen;
		dialog.dialogId = snapshot.dialogId;
		dialog.lastMessageNumber = snapshot.lastMessageNumber;
		dialog.isInitialized = snapshot.isInitialized;
		dialog.isWaiting = snapshot.pending.length > 0;
		dialog.interactions = snapshot.pending.map((pending) => restoreInteraction(config, pending));

		if (!snapshot.keepOpen) {
			dialog.interactions.push(new EndDialogInteraction());
		}

		dialog.interactions.forEach((interaction) => {
			interaction.dialog = dialog;
		});

		return dialog;
	}

	/** Initialised at the bank and not ended: further interactions can be run. */
	get isOpen(): boolean {
		return this.isInitialized && !this.hasEnded;
	}

	/**
	 * Sends the current interaction and every one after it, until the bank asks for a
	 * TAN, refuses, or nothing is left.
	 */
	private async advance(firstMessage?: CustomerMessage): Promise<Map<string, ClientResponse>> {
		let clientResponse: ClientResponse;
		let message = firstMessage;

		do {
			message ??= this.createCurrentCustomerMessage();
			const responseMessage = await this.httpClient.sendMessage(message);

			// The message is out. Whatever goes wrong from here must not look like an
			// error from before it was sent.
			try {
				await this.handlePartedMessages(message, responseMessage, this.currentInteraction);
				clientResponse = this.currentInteraction.handleClientResponse(responseMessage);
			} catch (cause) {
				throw cause instanceof BankExchangeError
					? cause
					: new BankExchangeError('The answer of the bank could not be read', 'answer', { cause });
			}

			message = undefined;
			this.checkEnded(clientResponse);
			this.dialogId = clientResponse.dialogId;
			this.responses.set(this.currentInteraction.segId, clientResponse);
			this.isWaiting = clientResponse.requiresTan;

			if (clientResponse.success && !clientResponse.requiresTan) {
				this.currentInteractionIndex++;

				if (this.currentInteractionIndex > 0) {
					this.isInitialized = true;
				}
			}
		} while (
			!this.hasEnded &&
			this.currentInteractionIndex < this.interactions.length &&
			clientResponse.success &&
			!clientResponse.requiresTan
		);

		return this.responses;
	}

	addCustomerInteraction(interaction: CustomerInteraction, afterCurrent = false): void {
		if (this.hasEnded) {
			throw Error('cannot queue another customer interaction when dialog has already ended');
		}

		const isCustomerOrder = interaction instanceof CustomerOrderInteraction;

		if (isCustomerOrder && !this.config.isTransactionSupported(interaction.segId)) {
			throw Error(
				`customer order transaction ${interaction.segId} is not supported according to the BPD`,
			);
		}

		interaction.dialog = this;

		if (afterCurrent) {
			this.interactions.splice(this.currentInteractionIndex + 1, 0, interaction);
			return;
		}

		// Before the end of the dialog, where it has one.
		const hasEnd = this.interactions.at(-1) instanceof EndDialogInteraction;
		this.interactions.splice(this.interactions.length - (hasEnd ? 1 : 0), 0, interaction);
	}

	private createCurrentCustomerMessage(): CustomerMessage {
		this.lastMessageNumber++;

		const isCustomerOrder = this.currentInteraction instanceof CustomerOrderInteraction;
		const message = isCustomerOrder
			? new CustomerOrderMessage(
					this.currentInteraction.segId,
					this.currentInteraction.responseSegId,
					this.dialogId,
					this.lastMessageNumber,
				)
			: new CustomerMessage(this.dialogId, this.lastMessageNumber);

		const tanMethod = this.config.selectedTanMethod;
		const isScaSupported = tanMethod && tanMethod.version >= 6;
		let isTanMethodNeeded = isScaSupported && this.currentInteraction.segId !== HKEND.Id;

		if (isCustomerOrder) {
			const bankTransaction = this.config.bankingInformation.bpd?.allowedTransactions.find(
				(t) => t.transId === this.currentInteraction.segId,
			);

			isTanMethodNeeded = isTanMethodNeeded && bankTransaction?.tanRequired;
		}

		if (this.config.userId && this.config.pin) {
			message.sign(
				this.config.countryCode,
				this.config.bankId,
				this.config.userId,
				this.config.pin,
				this.config.bankingInformation.systemId,
				isScaSupported ? this.config.tanMethodId : undefined,
			);
		}

		const segments = this.currentInteraction.getSegments(this.config);
		segments.forEach((segment) => {
			message.addSegment(segment);
		});

		if (this.config.userId && this.config.pin && isTanMethodNeeded) {
			const hktan: HKTANSegment = {
				header: { segId: HKTAN.Id, segNr: 0, version: tanMethod?.version ?? 0 },
				tanProcess: TanProcess.Process4,
				segId: this.currentInteraction.segId,
				tanMedia: this.getTanMediaName(),
			};

			message.addSegment(hktan);
		}

		return message;
	}

	private createCurrentTanMessage(tanOrderReference: string, tan?: string): CustomerMessage {
		this.lastMessageNumber++;
		const message = new CustomerMessage(this.dialogId, this.lastMessageNumber);

		if (this.config.userId && this.config.pin) {
			message.sign(
				this.config.countryCode,
				this.config.bankId,
				this.config.userId,
				this.config.pin,
				this.config.bankingInformation?.systemId,
				this.config.tanMethodId,
				tan,
			);
		}

		if (this.config.userId && this.config.pin && this.config.tanMethodId) {
			const hktan: HKTANSegment = {
				header: { segId: HKTAN.Id, segNr: 0, version: this.config.selectedTanMethod?.version ?? 0 },
				tanProcess: this.config.selectedTanMethod?.isDecoupled
					? TanProcess.Status
					: TanProcess.Process2,
				segId: this.currentInteraction.segId,
				orderRef: tanOrderReference,
				nextTan: false,
				tanMedia: this.getTanMediaName(),
			};

			message.addSegment(hktan);
		}
		return message;
	}

	private getTanMediaName(): string | undefined {
		const requirement =
			this.config.selectedTanMethod?.tanMediaRequirement ?? TanMediaRequirement.NotAllowed;

		if (requirement === TanMediaRequirement.NotAllowed) {
			return undefined;
		}

		if (requirement === TanMediaRequirement.Required) {
			return this.config.tanMediaName ?? 'default';
		}

		return this.config.tanMediaName;
	}

	/**
	 * Collects a response that the bank spreads over several messages.
	 *
	 * When the bank cannot fit a response into one message it answers with code 3040 plus
	 * a continuation mark. Repeating the order with that mark yields the next portion —
	 * as a COMPLETE, self-contained response segment, not as a byte-wise continuation of
	 * the previous one. A HICAZ follow-up, for example, repeats the account and the CAMT
	 * descriptor before carrying its own share of the statements.
	 *
	 * Every portion is therefore decoded on its own and all of them are placed into the
	 * response message the caller holds. Combining their payloads needs to know what the
	 * payload means — one MT940 stream continues, a list of CAMT documents is appended —
	 * so that step belongs to the interaction, which does it via `findAllSegments`.
	 */
	private async handlePartedMessages(
		message: CustomerMessage,
		responseMessage: Message,
		interaction: CustomerInteraction,
	) {
		// ALL of them, not just the first: one bank message may well carry several
		// response segments. Taking only the first left the rest sitting in the tree as
		// PARTED, where `findAllSegments` cannot see them — lost without a trace.
		const partedSegments = responseMessage.findAllSegments<PartedSegment>(PARTED.Id);

		if (partedSegments.length === 0) {
			return;
		}

		// The message the caller holds — every portion has to end up in THIS one, not in
		// the last one we happen to receive.
		const callersMessage = responseMessage;
		const rawPortions = partedSegments.map((segment) => segment.rawData);

		while (responseMessage.hasReturnCode(3040)) {
			const answers = responseMessage.getBankAnswers();
			const segmentWithContinuation = message.segments.find(
				(s) => s.header.segId === interaction.segId,
			) as SegmentWithContinuationMark;
			if (!segmentWithContinuation) {
				throw new Error(
					`Response contains segment with further information, but corresponding segment could not be found or is not specified`,
				);
			}

			const answer = answers.find((a) => a.code === 3040);

			if (!answer || !answer.params || answer.params.length === 0) {
				throw new Error('Expected bank answer to contain continuation mark parameters (code 3040)');
			}

			segmentWithContinuation.continuationMark = answer.params[0];
			const hnhbkSegment = message.findSegment<HNHBKSegment>(HNHBK.Id);
			if (!hnhbkSegment) {
				throw new Error('HNHBK segment not found in message');
			}
			hnhbkSegment.msgNr = ++this.lastMessageNumber;
			const nextResponseMessage = await this.httpClient.sendMessage(message);
			rawPortions.push(
				...nextResponseMessage
					.findAllSegments<PartedSegment>(PARTED.Id)
					.map((segment) => segment.rawData),
			);

			responseMessage = nextResponseMessage;
		}

		// Every PARTED placeholder gives way to the decoded portions, at the position of
		// the first one so the segment order stays intact.
		const index = callersMessage.segments.indexOf(partedSegments[0]);
		const withoutPlaceholders = callersMessage.segments.filter(
			(segment) => segment.header.segId !== PARTED.Id,
		);
		withoutPlaceholders.splice(index, 0, ...rawPortions.map((raw) => decode(raw)));
		callersMessage.segments = withoutPlaceholders;
	}

	private checkEnded(response: ClientResponse) {
		if (
			response.bankAnswers.some((answer) => answer.code === 100) ||
			response.bankAnswers.some((answer) => answer.code === 9000)
		) {
			this.hasEnded = true;
		}
	}

	private getHttpClient(): HttpClient {
		return new HttpClient(this.config.bankingUrl, this.config.debugEnabled);
	}
}
