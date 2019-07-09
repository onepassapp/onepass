import React, { Component } from 'react';
import { Layout } from 'antd';
import styled from 'styled-components';

import ItemModal from './ItemModal';
import VaultFooter from './VaultFooter';
import VaultSideBar from './VaultSideBar';
import VaultHeader from './VaultHeader';
import VaultContent from './VaultContent';

const VaultLayout = styled(Layout)`
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
`;

class Vault extends Component {
    render() {
        return (
            <VaultLayout className="mh-100">
                <VaultSideBar />
                <Layout>
                    <VaultHeader />
                    <VaultContent />
                    <VaultFooter />
                </Layout>
                <ItemModal />
            </VaultLayout>
        );
    }
}

export default Vault;
