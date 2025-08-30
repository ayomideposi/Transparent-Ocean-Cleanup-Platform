import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface DonationRecord {
  donor: string;
  initiativeId: number;
  amount: number;
  fee: number;
  timestamp: number;
  memo?: string;
}

interface Contribution {
  amount: number;
  timestamp: number;
  count: number;
}

interface InitiativeStats {
  totalAmount: number;
  donorCount: number;
  lastDonation: number;
}

interface DonorStats {
  totalDonated: number;
  initiativesSupported: number;
  lastDonation: number;
}

interface FeeRecipient {
  percentage: number;
  totalReceived: number;
}

interface ContractState {
  admin: string;
  paused: boolean;
  escrowContract: string;
  initiativeContract: string;
  governanceTokenContract: string;
  platformFeePercentage: number;
  totalDonations: number;
  donationCounter: number;
  donorContributions: Map<string, Contribution>; // Key: `${donor}_${initiativeId}`
  initiativeDonations: Map<number, InitiativeStats>;
  donationHistory: Map<number, DonationRecord>;
  donorStats: Map<string, DonorStats>;
  feeRecipients: Map<string, FeeRecipient>;
}

// Mock contract implementation
class DonationContractMock {
  private state: ContractState = {
    admin: "deployer",
    paused: false,
    escrowContract: "escrow",
    initiativeContract: "initiative",
    governanceTokenContract: "govtoken",
    platformFeePercentage: 5,
    totalDonations: 0,
    donationCounter: 0,
    donorContributions: new Map(),
    initiativeDonations: new Map(),
    donationHistory: new Map(),
    donorStats: new Map(),
    feeRecipients: new Map([["platform", { percentage: 100, totalReceived: 0 }]]),
  };

  private ERR_UNAUTHORIZED = 100;
  private ERR_PAUSED = 101;
  private ERR_INVALID_AMOUNT = 102;
  private ERR_INVALID_INITIATIVE = 103;
  private ERR_MEMO_TOO_LONG = 106;
  private ERR_INVALID_FEE_PERCENTAGE = 110;
  private MAX_MEMO_LEN = 256;
  private MAX_FEE_PERCENTAGE = 10;

  // Mock external calls - assume success for tests
  private mockIsValidInitiative(initiativeId: number): ClarityResponse<boolean> {
    return initiativeId > 0 ? { ok: true, value: true } : { ok: false, value: this.ERR_INVALID_INITIATIVE };
  }

  private mockDepositFunds(initiativeId: number, amount: number): ClarityResponse<boolean> {
    return { ok: true, value: true };
  }

  private mockMintTokens(recipient: string, amount: number): ClarityResponse<boolean> {
    return { ok: true, value: true };
  }

  private calculateFee(amount: number): number {
    return Math.floor((amount * this.state.platformFeePercentage) / 100);
  }

  private getContributionKey(donor: string, initiativeId: number): string {
    return `${donor}_${initiativeId}`;
  }

  donate(caller: string, initiativeId: number, amount: number, memo?: string): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (!this.mockIsValidInitiative(initiativeId).ok) {
      return { ok: false, value: this.ERR_INVALID_INITIATIVE };
    }
    if (memo && memo.length > this.MAX_MEMO_LEN) {
      return { ok: false, value: this.ERR_MEMO_TOO_LONG };
    }

    const fee = this.calculateFee(amount);
    const netAmount = amount - fee;
    const timestamp = Date.now();

    // Mock STX transfer (assume success)
    // Distribute fee
    for (const [recipient, data] of this.state.feeRecipients) {
      const share = Math.floor((fee * data.percentage) / 100);
      data.totalReceived += share;
    }

    // Mock escrow deposit
    this.mockDepositFunds(initiativeId, netAmount);

    // Mock governance mint
    this.mockMintTokens(caller, Math.floor(amount / 100));

    const donationId = this.state.donationCounter + 1;
    this.state.donationHistory.set(donationId, {
      donor: caller,
      initiativeId,
      amount,
      fee,
      timestamp,
      memo,
    });

    this.state.donationCounter = donationId;
    this.state.totalDonations += amount;

    // Update donor contrib
    const contribKey = this.getContributionKey(caller, initiativeId);
    const currentContrib = this.state.donorContributions.get(contribKey) ?? { amount: 0, timestamp: 0, count: 0 };
    const newContrib = {
      amount: currentContrib.amount + amount,
      timestamp,
      count: currentContrib.count + 1,
    };
    this.state.donorContributions.set(contribKey, newContrib);

    // Update donor stats
    const currentStats = this.state.donorStats.get(caller) ?? { totalDonated: 0, initiativesSupported: 0, lastDonation: 0 };
    const isNewInitiative = currentContrib.count === 0;
    const newStats = {
      totalDonated: currentStats.totalDonated + amount,
      initiativesSupported: isNewInitiative ? currentStats.initiativesSupported + 1 : currentStats.initiativesSupported,
      lastDonation: timestamp,
    };
    this.state.donorStats.set(caller, newStats);

    // Update initiative stats
    const currentInit = this.state.initiativeDonations.get(initiativeId) ?? { totalAmount: 0, donorCount: 0, lastDonation: 0 };
    const newInit = {
      totalAmount: currentInit.totalAmount + amount,
      donorCount: isNewInitiative ? currentInit.donorCount + 1 : currentInit.donorCount,
      lastDonation: timestamp,
    };
    this.state.initiativeDonations.set(initiativeId, newInit);

    return { ok: true, value: donationId };
  }

  setEscrowContract(caller: string, newEscrow: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.escrowContract = newEscrow;
    return { ok: true, value: true };
  }

  setInitiativeContract(caller: string, newInitiative: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.initiativeContract = newInitiative;
    return { ok: true, value: true };
  }

  setGovernanceTokenContract(caller: string, newGov: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.governanceTokenContract = newGov;
    return { ok: true, value: true };
  }

  setPlatformFee(caller: string, newFee: number): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (newFee > this.MAX_FEE_PERCENTAGE) {
      return { ok: false, value: this.ERR_INVALID_FEE_PERCENTAGE };
    }
    this.state.platformFeePercentage = newFee;
    return { ok: true, value: true };
  }

  addFeeRecipient(caller: string, recipient: string, percentage: number): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (percentage > 100) {
      return { ok: false, value: this.ERR_INVALID_FEE_PERCENTAGE };
    }
    this.state.feeRecipients.set(recipient, { percentage, totalReceived: 0 });
    return { ok: true, value: true };
  }

  removeFeeRecipient(caller: string, recipient: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.feeRecipients.delete(recipient);
    return { ok: true, value: true };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.paused = false;
    return { ok: true, value: true };
  }

  transferAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  getTotalDonations(): ClarityResponse<number> {
    return { ok: true, value: this.state.totalDonations };
  }

  getDonationDetails(donationId: number): ClarityResponse<DonationRecord | undefined> {
    return { ok: true, value: this.state.donationHistory.get(donationId) };
  }

  getDonorContribution(donor: string, initiativeId: number): ClarityResponse<Contribution | undefined> {
    return { ok: true, value: this.state.donorContributions.get(this.getContributionKey(donor, initiativeId)) };
  }

  getInitiativeStats(initiativeId: number): ClarityResponse<InitiativeStats | undefined> {
    return { ok: true, value: this.state.initiativeDonations.get(initiativeId) };
  }

  getDonorStats(donor: string): ClarityResponse<DonorStats | undefined> {
    return { ok: true, value: this.state.donorStats.get(donor) };
  }

  getPlatformFee(): ClarityResponse<number> {
    return { ok: true, value: this.state.platformFeePercentage };
  }

  getIsPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.paused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }

  getEscrowContract(): ClarityResponse<string> {
    return { ok: true, value: this.state.escrowContract };
  }

  getInitiativeContract(): ClarityResponse<string> {
    return { ok: true, value: this.state.initiativeContract };
  }

  getGovernanceTokenContract(): ClarityResponse<string> {
    return { ok: true, value: this.state.governanceTokenContract };
  }

  getFeeRecipient(recipient: string): ClarityResponse<FeeRecipient | undefined> {
    return { ok: true, value: this.state.feeRecipients.get(recipient) };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  donor1: "wallet_1",
  donor2: "wallet_2",
};

describe("DonationContract", () => {
  let contract: DonationContractMock;

  beforeEach(() => {
    contract = new DonationContractMock();
    vi.resetAllMocks();
  });

  it("should allow donation and update stats correctly", () => {
    const donateResult = contract.donate(accounts.donor1, 1, 1000, "For ocean cleanup");
    expect(donateResult).toEqual({ ok: true, value: 1 });

    expect(contract.getTotalDonations()).toEqual({ ok: true, value: 1000 });

    const donationDetails = contract.getDonationDetails(1);
    expect(donationDetails).toEqual({
      ok: true,
      value: expect.objectContaining({
        donor: accounts.donor1,
        initiativeId: 1,
        amount: 1000,
        fee: 50,
        memo: "For ocean cleanup",
      }),
    });

    const donorContrib = contract.getDonorContribution(accounts.donor1, 1);
    expect(donorContrib).toEqual({
      ok: true,
      value: { amount: 1000, timestamp: expect.any(Number), count: 1 },
    });

    const donorStats = contract.getDonorStats(accounts.donor1);
    expect(donorStats).toEqual({
      ok: true,
      value: { totalDonated: 1000, initiativesSupported: 1, lastDonation: expect.any(Number) },
    });

    const initStats = contract.getInitiativeStats(1);
    expect(initStats).toEqual({
      ok: true,
      value: { totalAmount: 1000, donorCount: 1, lastDonation: expect.any(Number) },
    });

    const feeRecipient = contract.getFeeRecipient("platform");
    expect(feeRecipient).toEqual({
      ok: true,
      value: { percentage: 100, totalReceived: 50 },
    });
  });

  it("should prevent donation when paused", () => {
    contract.pauseContract(accounts.deployer);
    const donateResult = contract.donate(accounts.donor1, 1, 1000);
    expect(donateResult).toEqual({ ok: false, value: 101 });
  });

  it("should prevent invalid amount donation", () => {
    const donateResult = contract.donate(accounts.donor1, 1, 0);
    expect(donateResult).toEqual({ ok: false, value: 102 });
  });

  it("should prevent donation to invalid initiative", () => {
    const donateResult = contract.donate(accounts.donor1, 0, 1000);
    expect(donateResult).toEqual({ ok: false, value: 103 });
  });

  it("should prevent long memo", () => {
    const longMemo = "a".repeat(257);
    const donateResult = contract.donate(accounts.donor1, 1, 1000, longMemo);
    expect(donateResult).toEqual({ ok: false, value: 106 });
  });

  it("should allow admin to set platform fee", () => {
    const setFee = contract.setPlatformFee(accounts.deployer, 8);
    expect(setFee).toEqual({ ok: true, value: true });
    expect(contract.getPlatformFee()).toEqual({ ok: true, value: 8 });
  });

  it("should prevent non-admin from setting fee", () => {
    const setFee = contract.setPlatformFee(accounts.donor1, 8);
    expect(setFee).toEqual({ ok: false, value: 100 });
  });

  it("should prevent fee above max", () => {
    const setFee = contract.setPlatformFee(accounts.deployer, 11);
    expect(setFee).toEqual({ ok: false, value: 110 });
  });

  it("should allow adding and removing fee recipient", () => {
    const addRecipient = contract.addFeeRecipient(accounts.deployer, "new_recipient", 50);
    expect(addRecipient).toEqual({ ok: true, value: true });

    let recipient = contract.getFeeRecipient("new_recipient");
    expect(recipient).toEqual({ ok: true, value: { percentage: 50, totalReceived: 0 } });

    const removeRecipient = contract.removeFeeRecipient(accounts.deployer, "new_recipient");
    expect(removeRecipient).toEqual({ ok: true, value: true });

    recipient = contract.getFeeRecipient("new_recipient");
    expect(recipient).toEqual({ ok: true, value: undefined });
  });

  it("should allow pausing and unpausing", () => {
    const pause = contract.pauseContract(accounts.deployer);
    expect(pause).toEqual({ ok: true, value: true });
    expect(contract.getIsPaused()).toEqual({ ok: true, value: true });

    const unpause = contract.unpauseContract(accounts.deployer);
    expect(unpause).toEqual({ ok: true, value: true });
    expect(contract.getIsPaused()).toEqual({ ok: true, value: false });
  });

  it("should allow transferring admin", () => {
    const transfer = contract.transferAdmin(accounts.deployer, accounts.donor1);
    expect(transfer).toEqual({ ok: true, value: true });
    expect(contract.getAdmin()).toEqual({ ok: true, value: accounts.donor1 });
  });

  it("should handle multiple donations correctly", () => {
    contract.donate(accounts.donor1, 1, 1000);
    contract.donate(accounts.donor1, 1, 500); // Same initiative
    contract.donate(accounts.donor1, 2, 2000); // New initiative

    expect(contract.getTotalDonations()).toEqual({ ok: true, value: 3500 });

    const donorStats = contract.getDonorStats(accounts.donor1);
    expect(donorStats).toEqual({
      ok: true,
      value: { totalDonated: 3500, initiativesSupported: 2, lastDonation: expect.any(Number) },
    });

    const contrib1 = contract.getDonorContribution(accounts.donor1, 1);
    expect(contrib1).toEqual({
      ok: true,
      value: { amount: 1500, timestamp: expect.any(Number), count: 2 },
    });

    const init1 = contract.getInitiativeStats(1);
    expect(init1).toEqual({
      ok: true,
      value: { totalAmount: 1500, donorCount: 1, lastDonation: expect.any(Number) },
    });
  });
});