import { toNano } from '@ton/core';
import { Contract1 } from '../wrappers/Contract1';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const contract1 = provider.open(Contract1.createFromConfig({}, await compile('Contract1')));

    await contract1.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(contract1.address);

    // run methods on `contract1`
}
