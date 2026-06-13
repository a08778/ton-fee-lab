import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractABI,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano
} from '@ton/core';
import { Op } from './Constants';

export type HolderConfig = {
    admin: Address,
    val: Cell
};

export type LastTxInfo = {
    myBalance: bigint,
    msgValue: bigint,
    myStorageDue: bigint
};

function lastTxInfoFromCell(cell: Cell | null): LastTxInfo | null {
    if (!cell)
        return null;

    const slice = cell.beginParse();

    return {
        myBalance: slice.loadCoins(),
        msgValue: slice.loadCoins(),
        myStorageDue: slice.loadCoins()
    };
}

// default#_ admin:MsgAddress val:^Cell last_tx_info:^Cell = HolderStorage;
export function holderConfigToCell(config: HolderConfig): Cell {
    return beginCell()
        .storeAddress(config.admin)
        .storeRef(config.val)
        .storeMaybeRef(null)            // last tx info
        .endCell();
}

export class Holder implements Contract {
    abi: ContractABI = { name: 'Holder' }

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new Holder(address);
    }

    static createFromConfig(config: HolderConfig, code: Cell, workchain = 0) {
        const data = holderConfigToCell(config);
        const init = { code, data };
        return new Holder(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }


     // replace#42c435f4 query_id:uint64 val:^Cell = HolderInternalMsg;
    static replaceMessage(val: Cell, queryId: bigint | number = 0)
    {
        return beginCell()
            .storeUint(Op.replace, 32)
            .storeUint(queryId, 64)
            .storeRef(val)
            .endCell();
    }

    async sendReplace(provider: ContractProvider, via: Sender, val: Cell, 
        bounce: boolean = false, value: bigint = toNano('0.05'), 
        queryId: bigint | number = 0) 
    {
        await provider.internal(via, {
            value,
            body: Holder.replaceMessage(val, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            bounce: bounce
        });
    }

   
    /*
        Get methods
    */
    async getContractData(provider: ContractProvider): Promise<{ admin: Address, val: Cell }> {
        const { stack } = await provider.get('get_holder_data', []);
        return {
            admin: stack.readAddress(),
            val: stack.readCell()
        };
    }

     async getLastTxInfo(provider: ContractProvider): Promise<LastTxInfo | null> {
        const { stack } = await provider.get('get_last_tx_info', []);
        return lastTxInfoFromCell(stack.readCellOpt());
    }
}