import { Blockchain, BlockchainSnapshot, BlockchainTransaction, printTransactionFees, SandboxContract, SendMessageResult, SmartContract, TreasuryContract } from '@ton/sandbox';
import { AccountState, AccountStatus, AccountStatusChange, Address, beginCell, Cell, fromNano, toNano } from '@ton/core';
import { Holder } from '../wrappers/Holder';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { calcStorageFee, computedGeneric, computeGasFee, DueLimits, getDueLimits, getGasePrices, getGasPrices, getStoragePrices, setStoragePrices, storageGeneric, StorageStats } from '../gasUtils';
import { findTransactionRequired } from '@ton/test-utils';
import { randomInt } from 'crypto';
import { Op } from '../wrappers/Constants';

const APPROX_TOLERANCE = 5n;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;
const SECONDS_PER_WEEK = 7 * 24 * 60 * 60;
const REPLACE_MSG_GAS_USED = 2662n;

function expectBigIntToBeCloseTo(actual: bigint, expected: bigint, tolerance: bigint) {
    const difference = actual >= expected ? actual - expected : expected - actual;
    expect(difference).toBeLessThanOrEqual(tolerance);
}

type ContractParams = {
    balance: bigint; 
    duePayment: bigint; 
    lastPaid: number; 
    storageStats: StorageStats;
    state: AccountState;
}

type InMsgParams = {
    value: bigint;
    bounceable: boolean;
};

type TransactionParams = {
    msgValueBeforeComputePhase: bigint;
    balanceBeforeComputePhase: bigint;
    storageFeeCollected: bigint;
    duePayment: bigint;
    statusChange: AccountStatusChange;
    lastPaid: number;
};

describe('StorageFee', () => {
    let code: Cell;

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<Holder>;

    let initial__state: BlockchainSnapshot;

    let calcStorageFeeFor: (storageStats: StorageStats, durationSeconds: number) => bigint;
    let printStorageStat: (address: Address, res: SendMessageResult, txPattern: {}) => void;
    let genRandomVal: (cells: number) => Cell;
    let extractContractParams: (contract: SmartContract) => ContractParams;
    let findStorageFeePeriod: (contract: ContractParams, minStorageFee: bigint, intervalSeconds: number) => number;
    let advanceTime: (seconds: number) => number;
    let calcTransactionParams: (contract: ContractParams, now: number, dueLimits: DueLimits, inMsg: InMsgParams | null) => TransactionParams;
    
    beforeAll(async () => {
        code = await compile('Holder');

        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');

        calcStorageFeeFor = (storageStats: StorageStats, durationSeconds: number) => {
            const storagePrices  = getStoragePrices(blockchain.config);

           
            return calcStorageFee(storagePrices, storageStats,  BigInt(durationSeconds));
        }

        printStorageStat = async (address: Address, res: SendMessageResult, txPattern: {}) => {
            const contract = await blockchain.getContract(address);
          
            const tx = findTransactionRequired(res.transactions, txPattern);

            var storageStat = storageGeneric(tx);

            console.log("storage fee collected: ", fromNano(storageStat.storageFeesCollected)); 
            console.log("due payment: ", fromNano(storageStat.storageFeesDue ?? 0n)); 

            // account state
            console.log("account due pyament: ", fromNano(contract.account.account?.storageStats.duePayment ?? 0n)); 
            console.log("account state: ", contract.accountState?.type); // should be active (if due payment does not exceed 0.1) otherwise - frozen  
        }

        genRandomVal = (cells: number) => {
            if (!Number.isInteger(cells) || cells < 1) {
                throw new Error('Cell count must be a positive integer');
            }

            let val = beginCell().storeUint(randomInt(0, 100), 1023).endCell();
            for (let i = 1; i < cells; i++) {
                val = beginCell()
                    .storeUint(randomInt(0, 100), 1023)
                    .storeRef(val)
                    .endCell();
            }

            return val;
        }

        extractContractParams = (contract: SmartContract) => {
            const account = contract.account.account;
            if (!account)
                throw "Account is required";

            const bits = account.storageStats.used.bits;
            const cells = account.storageStats.used.cells;
            const storageStats = new StorageStats(bits, cells);

            return {
                balance: contract.balance,
                duePayment: account.storageStats.duePayment ?? 0n,
                lastPaid: account.storageStats.lastPaid,
                storageStats: storageStats,
                state: account.storage.state
            }
        };

        findStorageFeePeriod = (contract: ContractParams, minStorageFee: bigint, intervalSeconds: number) => {
            let elapsedSeconds = 0;
            let calculatedStorageFee = 0n;
            let totalStorageFee = contract.duePayment;

            while (totalStorageFee < minStorageFee) {
                elapsedSeconds += intervalSeconds;
                calculatedStorageFee = calcStorageFeeFor(contract.storageStats, elapsedSeconds);
                totalStorageFee = contract.duePayment + calculatedStorageFee;
            }

            return elapsedSeconds;
        }

        advanceTime = (seconds: number) => {
            const currentTime = blockchain.now ?? Math.floor(Date.now() / 1000);
            const now = currentTime + seconds;
            blockchain.now = now;
            return now;
        }

        calcTransactionParams = (contractBeforeTx: ContractParams, now: number, dueLimits: DueLimits, inMsg: InMsgParams | null) => {

            let balance = contractBeforeTx.balance;
            let msgValue = inMsg?.value ?? 0n;

            if (inMsg && inMsg.bounceable === false) {  // non-bounceable msg
                /*  credit phase */
                balance += msgValue;
            }
           
            /* 
                storage phase  
            */
            const elapsedSeconds = now - contractBeforeTx.lastPaid;
            const calculatedStorageFee = calcStorageFeeFor(contractBeforeTx.storageStats, elapsedSeconds);
            const totalStorageFee = contractBeforeTx.duePayment + calculatedStorageFee;

            const storageFeeCollected = totalStorageFee > balance 
                ? balance
                : totalStorageFee;

            balance -= storageFeeCollected;
            const duePayment = totalStorageFee - storageFeeCollected;  

           
            if (inMsg && inMsg.bounceable === true) {  // bounceable msg
                /*  credit phase */
                balance += msgValue;
            }

            if (balance < msgValue)
            {
                msgValue = balance;
            }
                
            let statusChange: AccountStatusChange = "unchanged";
            if (duePayment > dueLimits.delete_due_limit && contractBeforeTx.state.type != "active")
            {
                statusChange = "deleted";
            }

            if (duePayment > dueLimits.freeze_due_limit && contractBeforeTx.state.type == "active")
            {
                statusChange = "frozen";
            }
            


            /*  
                compute phase 
                action phase
                bounce phase
            */

            return {
                balanceBeforeComputePhase: balance,
                msgValueBeforeComputePhase: msgValue,
                duePayment: duePayment,
                storageFeeCollected: storageFeeCollected,
                statusChange: statusChange,
                lastPaid: now
            }
        }

        holder = blockchain.openContract(Holder.createFromConfig({
            admin: deployer.address,
            val: genRandomVal(randomInt(10, 100))
        }, code));

        const deployResult = await holder.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: holder.address,
            deploy: true,
            success: true,
        });

        // update storage prices
        const storagePrices = getStoragePrices(blockchain.config);
       
        const oldConfig = blockchain.config;
        const newPrices = {
            ...storagePrices,
            bit_price_ps: storagePrices.bit_price_ps * 10n,
            cell_price_ps: storagePrices.cell_price_ps * 10n,
        };

        blockchain.setConfig(setStoragePrices(oldConfig, newPrices));


        // take a snapshot
        initial__state = blockchain.snapshot();
    });


    it('should deploy', async () => {
        const data = await holder.getContractData();
        expect(data.val).not.toBeNull();
        expect(data.admin).toEqualAddress(deployer.address);

        const lastTxInfo = await holder.getLastTxInfo();
        expect(lastTxInfo).toBeNull();
    });

    describe('bounceable message', () => {
        beforeEach(async () => {
            await blockchain.loadFrom(initial__state);

            // Accrue unpaid storage fees on the contract
            const contract = await blockchain.getContract(holder.address);  
            contract.balance = 0n;
            const contractBeforeTx = extractContractParams(contract);
            const storageFeePeriod = findStorageFeePeriod(contractBeforeTx, toNano(randomInt(1, 10) / 1000), SECONDS_PER_MONTH); // 0.000 .. 0.009
            advanceTime(storageFeePeriod);
            await contract.runTickTock('tick');
        });

        describe('[total_storage_fee] > [balance_before_storage_phase]', () => {
            it('[due_payment_after_tx] < FREEZE_DUE_LIMIT', async () => {
                // arrange
                const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const msg_original_value = toNano(randomInt(1, 10)); // 1..9
                const is_bounceable = true;

                const contract = await blockchain.getContract(holder.address);  
                contract.balance = balance_before_tx;

                const contractBeforeTx = extractContractParams(contract);
                const dueLimits = getDueLimits(blockchain.config, 0);
            
                const storageFeePeriod = findStorageFeePeriod(contractBeforeTx, balance_before_tx, SECONDS_PER_YEAR);
                
                const now = advanceTime(storageFeePeriod);

                const inMsgParams = {
                    value: msg_original_value,
                    bounceable: is_bounceable
                };

                const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

                // console.log("contract data before tx: ", contractBeforeTx);
                // console.log("in msg params: ", inMsgParams);
                // console.log("expected tx params: ", txParams);

                // act
                const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

                // assert
                // printTransactionFees(res.transactions);

                const txPattern = {
                    from: deployer.address,
                    on: holder.address,
                    op: Op.replace,
                };

                const tx = findTransactionRequired(res.transactions, txPattern);
                const storageStat = storageGeneric(tx);
                const computeStat = computedGeneric(tx);
                
                expect(res.transactions).toHaveTransaction({
                    ...txPattern,
                    success: true
                });

                const lastTxInfo = await holder.getLastTxInfo();
                if (!lastTxInfo)
                    throw "Last tx info is null";
              
                expect(lastTxInfo.myBalance).toBe(txParams.balanceBeforeComputePhase);
                expect(lastTxInfo.msgValue).toBe(txParams.msgValueBeforeComputePhase);
                expect(lastTxInfo.myStorageDue).toBe(txParams.duePayment);

                expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected);
                expect(storageStat.storageFeesDue).toBe(txParams.duePayment);
                expect(storageStat.statusChange).toBe(txParams.statusChange);    
                
                expect(contract.accountState?.type).toBe("active");
                expect(contract.balance).toBe(txParams.balanceBeforeComputePhase - computeStat.gasFees);
            });

            it('[due_payment_after_tx] > FREEZE_DUE_LIMIT', async () => {
                // arrange
                const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const msg_original_value = toNano(randomInt(1, 10)); // 1..9
                const is_bounceable = true;

                const contract = await blockchain.getContract(holder.address);  
                contract.balance = balance_before_tx;
                
                const contractBeforeTx = extractContractParams(contract);
                const dueLimits = getDueLimits(blockchain.config, 0);

                const storageFeePeriod = findStorageFeePeriod(
                    contractBeforeTx, 
                    balance_before_tx + dueLimits.freeze_due_limit,
                    SECONDS_PER_YEAR);

                const now = advanceTime(storageFeePeriod);

                const inMsgParams = {
                    value: msg_original_value,
                    bounceable: is_bounceable
                };

                const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

                // console.log("contract data before tx: ", contractBeforeTx);
                // console.log("in msg params: ", inMsgParams);
                // console.log("expected tx params: ", txParams);

                // act
                const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

                // assert
                const txPattern = {
                    from: deployer.address,
                    on: holder.address,
                    op: Op.replace,
                };

                const tx = findTransactionRequired(res.transactions, txPattern);
                const storageStat = storageGeneric(tx);

                expect(res.transactions).toHaveTransaction({
                    ...txPattern,
                    success: false,
                    aborted: true
                });

                expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected);
                expect(storageStat.storageFeesDue).toBe(txParams.duePayment);
                expect(storageStat.statusChange).toBe(txParams.statusChange);            
                
                expect(contract.accountState?.type).toBe("uninit");
                expect(contract.balance).toBe(0n);
            });

            it('[due_payment_after_tx] > DELETE_DUE_LIMIT & tx for account deletion', async () => {
                // arrange
                const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const msg_original_value = toNano(randomInt(1, 10)); // 1..9
                const is_bounceable = true;

                const contract = await blockchain.getContract(holder.address);  
                contract.balance = balance_before_tx;

                let contractBeforeTx = extractContractParams(contract);
                const dueLimits = getDueLimits(blockchain.config, 0);

                const storageFeePeriod = findStorageFeePeriod(
                    contractBeforeTx, 
                    balance_before_tx + dueLimits.delete_due_limit, 
                    SECONDS_PER_YEAR);
                
                const now = advanceTime(storageFeePeriod);

                // first, get the account to be frozen
                await contract.runTickTock('tick');

                contractBeforeTx = extractContractParams(contract);

                const inMsgParams = {
                    value: msg_original_value,
                    bounceable: is_bounceable
                };

                const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

                // console.log("contract data before tx: ", contractBeforeTx);
                // console.log("in msg params: ", inMsgParams);
                // console.log("expected tx params: ", txParams);

                // act
                const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

                // printTransactionFees(res.transactions);

                // assert
                const txPattern = {
                    from: deployer.address,
                    on: holder.address,
                    op: Op.replace,
                };

                const tx = findTransactionRequired(res.transactions, txPattern);
                const storageStat = storageGeneric(tx);

                expect(res.transactions).toHaveTransaction({
                    ...txPattern,
                    success: false,
                    aborted: true
                });

                expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected); 
                expect(storageStat.storageFeesDue).toBe(txParams.duePayment);
                expect(storageStat.statusChange).toBe(txParams.statusChange);    
                       
                expect(contract.accountState?.type).toBeUndefined();
                expect(contract.balance).toBe(0n);       
            });
        });
        
    })

    describe('non-bounceable message', () => {
        beforeEach(async () => {
            await blockchain.loadFrom(initial__state);

            // Accrue unpaid storage fees on the contract
            const contract = await blockchain.getContract(holder.address);  
            contract.balance = 0n;
            const contractBeforeTx = extractContractParams(contract);
            const storageFeePeriod = findStorageFeePeriod(contractBeforeTx, toNano(randomInt(1, 10) / 1000), SECONDS_PER_MONTH); // 0.000 .. 0.009
            advanceTime(storageFeePeriod);
            await contract.runTickTock('tick');
        });

        it('[balance_before_credit_phase] < [total_storage_fee] < [balance_before_storage_phase]', async () => {
            // arrange
            const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
            const msg_original_value = toNano(randomInt(1, 10) / 10); // 0.1 . .0.9
            const is_bounceable = false;

            const contract = await blockchain.getContract(holder.address);  
            contract.balance = balance_before_tx;

            const contractBeforeTx = extractContractParams(contract);
            const dueLimits = getDueLimits(blockchain.config, 0);

            const storageFeePeriod = findStorageFeePeriod(
                contractBeforeTx, 
                balance_before_tx, 
                SECONDS_PER_YEAR);
            
            const now = advanceTime(storageFeePeriod);

            const inMsgParams = {
                value: msg_original_value,
                bounceable: is_bounceable
            };

            const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

            // console.log("contract data before tx: ", contractBeforeTx);
            // console.log("in msg params: ", inMsgParams);
            // console.log("expected tx params: ", txParams);
            
            // act
            const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

            // assert
            // printTransactionFees(res.transactions);

            const txPattern = {
                from: deployer.address,
                on: holder.address,
                op: Op.replace,
            };

            const tx = findTransactionRequired(res.transactions, txPattern);
            const storageStat = storageGeneric(tx);
            const computeStat = computedGeneric(tx);

            expect(res.transactions).toHaveTransaction({
                ...txPattern,
                success: true
            });

            const lastTxInfo = await holder.getLastTxInfo();
            if (!lastTxInfo)
                throw "Last tx info is null";

            expect(lastTxInfo.myBalance).toBe(txParams.balanceBeforeComputePhase);
            expect(lastTxInfo.msgValue).toBe(txParams.msgValueBeforeComputePhase);
            expect(lastTxInfo.myStorageDue).toBe(txParams.duePayment);
            expect(contract.accountState?.type).toBe("active");
            expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected);
            expect(storageStat.statusChange).toBe("unchanged");

            expect(contract.balance).toBe(txParams.balanceBeforeComputePhase - computeStat.gasFees);
        });

        describe('[total_storage_fee] > [balance_before_tx] + [msg_original_value]', () => {
            it('[due_payment_after_tx] < FREEZE_DUE_LIMIT', async () => {
                // arrange
                const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const msg_original_value = toNano(randomInt(1, 10) / 10); // 0.1 . .0.9
                const is_bounceable = false;

                const contract = await blockchain.getContract(holder.address);  
                contract.balance = balance_before_tx;

                const contractBeforeTx = extractContractParams(contract);
                const dueLimits = getDueLimits(blockchain.config, 0);
            
                const storageFeePeriod = findStorageFeePeriod(
                    contractBeforeTx, 
                    balance_before_tx + msg_original_value,
                    SECONDS_PER_YEAR);

                const now = advanceTime(storageFeePeriod);

                const inMsgParams = {
                    value: msg_original_value,
                    bounceable: is_bounceable
                };

                const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

                // console.log("contract data before tx: ", contractBeforeTx);
                // console.log("in msg params: ", inMsgParams);
                // console.log("expected tx params: ", txParams);

                // act
                const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

                // assert
                const txPattern = {
                    from: deployer.address,
                    on: holder.address,
                    op: Op.replace,
                };

                const tx = findTransactionRequired(res.transactions, txPattern);
                const storageStat = storageGeneric(tx);

                expect(res.transactions).toHaveTransaction({
                    ...txPattern,
                    success: false,
                    aborted: true
                });

                expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected);
                expect(storageStat.storageFeesDue).toBe(txParams.duePayment);
                expect(storageStat.statusChange).toBe("unchanged");            
                
                expect(contract.accountState?.type).toBe("active");
                expect(contract.balance).toBe(0n);
            });

            it('[due_payment_after_tx] > FREEZE_DUE_LIMIT', async () => {
                // arrange
                const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const msg_original_value = toNano(randomInt(1, 10) / 10); // 0.1 . .0.9
                const is_bounceable = false;

                const contract = await blockchain.getContract(holder.address);  
                contract.balance = balance_before_tx;

                const contractBeforeTx = extractContractParams(contract);
                const dueLimits = getDueLimits(blockchain.config, 0);
            
                const storageFeePeriod = findStorageFeePeriod(
                    contractBeforeTx, 
                    balance_before_tx + msg_original_value + dueLimits.freeze_due_limit,
                    SECONDS_PER_YEAR);

                const now = advanceTime(storageFeePeriod);

                const inMsgParams = {
                    value: msg_original_value,
                    bounceable: is_bounceable
                };

                const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

                // console.log("contract data before tx: ", contractBeforeTx);
                // console.log("in msg params: ", inMsgParams);
                // console.log("expected tx params: ", txParams);

                // act
                const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

                // assert
                const txPattern = {
                    from: deployer.address,
                    on: holder.address,
                    op: Op.replace,
                };

                const tx = findTransactionRequired(res.transactions, txPattern);
                const storageStat = storageGeneric(tx);

                expect(res.transactions).toHaveTransaction({
                    ...txPattern,
                    success: false,
                    aborted: true
                });

                expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected);
                expect(storageStat.storageFeesDue).toBe(txParams.duePayment);
                expect(storageStat.statusChange).toBe("frozen");            
                
                expect(contract.accountState?.type).toBe("uninit");
                expect(contract.balance).toBe(0n);
            });

            it('[due_payment_after_tx] > DELETE_DUE_LIMIT & tx for account deletion', async () => {
                // arrange
                const balance_before_tx = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const msg_original_value = toNano(randomInt(1, 10) / 10); // 0.1 .. 0.9
                const is_bounceable = false;

                const contract = await blockchain.getContract(holder.address);  
                contract.balance = balance_before_tx;

                let contractBeforeTx = extractContractParams(contract);
                const dueLimits = getDueLimits(blockchain.config, 0);

                const storageFeePeriod = findStorageFeePeriod(
                    contractBeforeTx, 
                    balance_before_tx + msg_original_value + dueLimits.delete_due_limit, 
                    SECONDS_PER_YEAR);
                
                const now = advanceTime(storageFeePeriod);

                // first, get the account to be frozen
                await contract.runTickTock('tick');

                contractBeforeTx = extractContractParams(contract);

                const inMsgParams = {
                    value: msg_original_value,
                    bounceable: is_bounceable
                };

                const txParams = calcTransactionParams(contractBeforeTx, now, dueLimits, inMsgParams);

                // console.log("contract data before tx: ", contractBeforeTx);
                // console.log("in msg params: ", inMsgParams);
                // console.log("expected tx params: ", txParams);


                // act
                const res = await holder.sendReplace(deployer.getSender(), genRandomVal(randomInt(10, 100)), is_bounceable, msg_original_value);

                // printTransactionFees(res.transactions);

                // assert
                const txPattern = {
                    from: deployer.address,
                    on: holder.address,
                    op: Op.replace,
                };

                const tx = findTransactionRequired(res.transactions, txPattern);
                const storageStat = storageGeneric(tx);

                expect(res.transactions).toHaveTransaction({
                    ...txPattern,
                    success: false,
                    aborted: true
                });

                expect(storageStat.storageFeesCollected).toBe(txParams.storageFeeCollected);
                expect(storageStat.storageFeesDue).toBe(txParams.duePayment);
                expect(storageStat.statusChange).toBe(txParams.statusChange);            
                
                expect(contract.accountState?.type).toBeUndefined();
                expect(contract.balance).toBe(0n);
            });
        });
    })
});
