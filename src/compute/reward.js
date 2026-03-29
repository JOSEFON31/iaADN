// iaADN - Reward Engine: pay IOTAI tokens for compute contributions
// Nodes that contribute processing power get rewarded

export class RewardEngine {
  constructor({ iotaiBridge }) {
    this.iotaiBridge = iotaiBridge;
    this.rewardHistory = [];
  }

  // Calculate reward for a completed compute task
  calculateReward(task) {
    const baseFee = 1; // 1 IOTAI minimum
    const durationMultiplier = Math.max(1, Math.ceil((task.duration || 1000) / 1000));
    const complexityMultiplier = task.type === 'inference' ? 2 : 1;

    return baseFee * durationMultiplier * complexityMultiplier;
  }

  // Issue reward to a worker node
  async issueReward(wallet, workerAddress, task) {
    const amount = this.calculateReward(task);

    const result = await this.iotaiBridge.payForCompute(
      wallet,
      workerAddress,
      amount,
      task.id
    );

    this.rewardHistory.push({
      taskId: task.id,
      workerAddress,
      amount,
      timestamp: Date.now(),
      ...result,
    });

    return { amount, ...result };
  }

  // Get total rewards issued
  getTotalRewards() {
    return this.rewardHistory.reduce((sum, r) => sum + r.amount, 0);
  }

  getHistory() {
    return [...this.rewardHistory];
  }
}
