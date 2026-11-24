'use strict';

// npx mocha tests/test-Peer.js

require('should');

const Peer = require('../app/src/Peer');

describe('test-Peer', () => {
    const newPeer = () => new Peer('socket-1', { peer_info: { peer_name: 'tari', peer_uuid: 'u-1' } });

    it('starts with the torch unsupported and off', () => {
        const peer = newPeer();
        peer.peer_info.peer_torch_supported.should.equal(false);
        peer.peer_info.peer_torch.should.equal(false);
    });

    it('stores torchSupported updates', () => {
        const peer = newPeer();
        peer.updatePeerInfo({ type: 'torchSupported', status: true });
        peer.peer_info.peer_torch_supported.should.equal(true);
    });

    it('stores torch on/off updates', () => {
        const peer = newPeer();
        peer.updatePeerInfo({ type: 'torch', status: true });
        peer.peer_info.peer_torch.should.equal(true);
        peer.updatePeerInfo({ type: 'torch', status: false });
        peer.peer_info.peer_torch.should.equal(false);
    });
});
