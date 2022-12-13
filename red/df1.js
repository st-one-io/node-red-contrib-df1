//@ts-check
/*
  Copyright: (c) 2021, ST-One
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

try {
    var DF1 = require('@protocols/node-df1').DF1Endpoint;
    var Port = require('@protocols/node-df1').DF1DataLinkSession;
    var {DF1AddressGroup} = require('@protocols/node-df1');
} catch (error) {
    var DF1 = null
    var Port = null
    var DF1AddressGroup = null
}

const MIN_CYCLE_TIME = 50;

module.exports = function (RED) {
    
    RED.httpAdmin.get('/__node-red-contrib-df1/discover/serialports', RED.auth.needsPermission('df1.discover'), function (req, res) {
        if (!Port) return res.status(500).end();
        Port.getPortsList().then(function (serialports) {
            res.json(serialports).end();
        }).catch(() => {
            res.status(500).end();
        });
    });
    
    // ----------- DF1 Endpoint -----------
    function generateStatus(status, val) {
        var obj;
        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._('df1.endpoint.status.online');
        }
        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._('df1.endpoint.status.offline')
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._('df1.endpoint.status.connecting')
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._('df1.endpoint.status.unknown')
                };
        }
        return obj;
    }

    function createTranslationTable(vars) {
        var res = {};

        vars.forEach(function (elm) {
            if (!elm.name || !elm.addr) {
                //skip incomplete entries
                return;
            }
            
            res[elm.name] = elm.addr;
        });

        return res;
    }

    function equals(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return false;
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length != b.length) return false;
    
            for (var i = 0; i < a.length; ++i) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        return false;
    }

    function nrInputShim(node, fn) {
        node.on('input', function (msg, send, done) {
            send = send || node.send;
            done = done || (err => err && node.error(err, msg));
            fn(msg, send, done);
        });
    }
    
    // <Begin> --- Endpoint ---
    function DF1Endpoint(config) {
        let oldValues = {};
        let readInProgress = false;
        let readDeferred = 0;
        let currentCycleTime = config.cycletime;
        let portPath = config.serialport;
        let errorMode = config.errormode;
        let baudRate = parseInt(config.baudrate);
        let _cycleInterval;
        let _reconnectTimeout = null;
        let connected = false;
        let status;
        let that = this;
        let df1 = null;
        let addressGroup = null;
        
        RED.nodes.createNode(this, config);

        //avoids warnings when we have a lot of DF1 In nodes
        this.setMaxListeners(0);

        this.getDf1Session = async () => {

            return new Promise ((res,rej) => {
                df1.getDf1Protocol()
                .then((df1Protocol) => {
                    res(df1Protocol.getDataLinkSession());
                });
            });
        };

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            that.emit('__STATUS__', status);
        }

        function doCycle() {
            if (!readInProgress && connected) {
                readInProgress = true;
                
                df1.readAddressGroup(addressGroup)
                .then(result => {
                    cycleCallback(result.values);
                })
                .catch(error => {
                    onError(error);
                    readInProgress = false;
                });

            } else {
                readDeferred++;
            }
        }

        function cycleCallback(values) {
            readInProgress = false;

            if (readDeferred && connected) {
                doCycle();
                readDeferred = 0;
            }

            manageStatus('online');

            var changed = false;
            that.emit('__ALL__', values);
            Object.keys(values).forEach(function (key) {
                if (!equals(oldValues[key], values[key])) {
                    changed = true;
                    that.emit(key, values[key]);
                    that.emit('__CHANGED__', {
                        key: key,
                        value: values[key]
                    });
                    oldValues[key] = values[key];
                }
            });
            if (changed) that.emit('__ALL_CHANGED__', values);
        }

        function updateCycleTime(interval) {
            let time = parseInt(interval);

            if (isNaN(time) || time < 0) {
                that.error(RED._("df1.endpoint.error.invalidtimeinterval", { interval: interval }));
                return false
            }

            clearInterval(_cycleInterval);

            // don't set a new timer if value is zero
            if (!time) return false;

            if (time < MIN_CYCLE_TIME) {
                that.warn(RED._("df1.endpoint.info.cycletimetooshort", { min: MIN_CYCLE_TIME }));
                time = MIN_CYCLE_TIME;
            } 

            currentCycleTime = time;
            _cycleInterval = setInterval(doCycle, time);

            return true;
        }

        function removeListeners() {
             if (df1 !== null) {
                that.removeListener('connected',onConnect)      
                that.removeListener('disconnected',onDisconnect) 
                that.removeListener('error',onError) 
                that.removeListener('timeout',onTimeout)           

                df1.removeListener('connected', onConnect);
                df1.removeListener('disconnected', onDisconnect);
                df1.removeListener('error', onError);
                df1.removeListener('timeout', onTimeout);
             }
        }

        /**
         * Destroys the DF1 connection
         * @param {Boolean} [reconnect=true]  
         * @returns {Promise}
         */
        async function disconnect(reconnect = true) {
            if (!connected) return;
            connected = false;

            clearInterval(_cycleInterval);
            _cycleInterval = null;

            if (df1) {
                if (!reconnect) df1.removeListener('disconnected', onDisconnect);
                await df1.destroy();
                removeListeners();
                df1 = null;
            }

            console.log("Endpoint - disconnect");
        }
        
        async function connect() {

            if (!DF1 || !DF1AddressGroup) return that.error('Missing "@protocols/node-df1" dependency, avaliable only on the ST-One hardware. Please contact us at "st-one.io" for pricing and more information.')
            
            manageStatus('connecting');
            
            if (_reconnectTimeout !== null) {
                clearTimeout(_reconnectTimeout);
                _reconnectTimeout = null;
            }
            
            if (df1 !== null) {
                await disconnect();
            }
            
            if (!portPath) {
                manageStatus('offline');
                that.error('Undefined port path!');
                return;
            }
            
            df1 = new DF1({portPath: portPath, baudRate: baudRate, errorMode: errorMode});

            addressGroup = new DF1AddressGroup();
        
            df1.on('connected', onConnect);
            df1.on('disconnected', onDisconnect);
            df1.on('error', onError);
            df1.on('timeout', onTimeout);

            df1.connect();
        }

        function onConnect() {
            readInProgress = false;
            readDeferred = 0;
            connected = true;

            that.emit('connected')

            manageStatus('online');

            let _vars = createTranslationTable(config.vartable);

            addressGroup.setTranslationCB(k => _vars[k]);
            let varKeys = Object.keys(_vars);

            if (!varKeys || !varKeys.length) {
                that.warn(RED._("df1.endpoint.info.novars"));
            } else {
                addressGroup.addAddress(varKeys);
                updateCycleTime(currentCycleTime);
            }
        }

        function onDisconnect() {

            that.emit('disconnected')

            manageStatus('offline');
            if (!_reconnectTimeout) {
                _reconnectTimeout = setTimeout(connect, 5000);
            }
        }

        function onError(e) {
            that.emit('error')

            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function onTimeout(e) {

            that.emit('timeout')

            manageStatus('offline');
            that.error(e && e.toString());
            disconnect();
        }

        function getStatus() {
            that.emit('__STATUS__', status);
        }

        function updateCycleEvent(obj) {
            if (connected) {
                obj.err = updateCycleTime(obj.msg.payload);
                that.emit('__UPDATE_CYCLE_RES__', obj);
            }
        }

        manageStatus('offline');

        this.on('__DO_CYCLE__', doCycle);
        this.on('__UPDATE_CYCLE__', updateCycleEvent);
        this.on('__GET_STATUS__', getStatus);

        connect();

        this.on('close', done => {
            manageStatus('offline');
            clearInterval(_cycleInterval);
            clearTimeout(_reconnectTimeout);
            _cycleInterval = null
            _reconnectTimeout = null;
            
            that.removeListener('__DO_CYCLE__', doCycle);
            that.removeListener('__UPDATE_CYCLE__', updateCycleEvent);
            that.removeListener('__GET_STATUS__', getStatus);           

            disconnect(false).then(done);

            console.log("Endpoint - on close!");
        });
        
    }

    RED.nodes.registerType('df1 endpoint', DF1Endpoint);
    // <End> --- Endpoint

    // <Begin> --- DF1 In
    function DF1In(config) {
        RED.nodes.createNode(this, config);
        let statusVal;
        let that = this

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            that.error(RED._("df1.error.missingconfig"));
            return;
        }

        function sendMsg(data, key, status) {
            if (key === undefined) key = '';
            if (data instanceof Date) data = data.getTime();
            var msg = {
                payload: data,
                topic: key
            };
            statusVal = status !== undefined ? status : data;
            that.send(msg);
            endpoint.emit('__GET_STATUS__');
        }
        
        function onChanged(variable) {
            sendMsg(variable.value, variable.key, null);
        }

        function onDataSplit(data) {
            Object.keys(data).forEach(function (key) {
                sendMsg(data[key], key, null);
            });
        }

        function onData(data) {
            sendMsg(data, config.mode == 'single' ? config.variable : '');
        }

        function onDataSelect(data) {
            onData(data[config.variable]);
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status, statusVal));
        }
        
        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.emit('__GET_STATUS__');

        if (config.diff) {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__CHANGED__', onChanged);
                    break;
                case 'single':
                    endpoint.on(config.variable, onData);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL_CHANGED__', onData);
            }
        } else {
            switch (config.mode) {
                case 'all-split':
                    endpoint.on('__ALL__', onDataSplit);
                    break;
                case 'single':
                    endpoint.on('__ALL__', onDataSelect);
                    break;
                case 'all':
                default:
                    endpoint.on('__ALL__', onData);
            }
        }

        this.on('close', function (done) {
            endpoint.removeListener('__ALL__', onDataSelect);
            endpoint.removeListener('__ALL__', onDataSplit);
            endpoint.removeListener('__ALL__', onData);
            endpoint.removeListener('__ALL_CHANGED__', onData);
            endpoint.removeListener('__CHANGED__', onChanged);
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener(config.variable, onData);
            done();
        });

    }

    RED.nodes.registerType('df1 in', DF1In);
    // <End> --- DF1 In

    // <Begin> --- DF1 Control
    function DF1Control(config) {
        let that = this;
        RED.nodes.createNode(this, config);

        let endpoint = RED.nodes.getNode(config.endpoint);

        if (!endpoint) {
            this.error(RED._("df1.error.missingconfig"));
            return;
        }

        function onEndpointStatus(status) {
            that.status(generateStatus(status));
        }

        function onMessage(msg, send, done) {
            let func = config.function || msg.function;
            switch (func) {
                case 'cycletime':
                    endpoint.emit('__UPDATE_CYCLE__', {
                        msg: msg,
                        send: send,
                        done: done
                    });
                    break;
                case 'trigger':
                    endpoint.emit('__DO_CYCLE__');
                    send(msg);
                    done();
                    break;

                default:
                    this.error(RED._("df1.error.invalidcontrolfunction", { function: config.function }), msg);
            }
        }

        function onUpdateCycle(res) {
            let err = res.err;
            if (!err) {
                res.done(err);
            } else {
                res.send(res.msg);
                res.done();
            }
        }

        endpoint.on('__STATUS__', onEndpointStatus);
        endpoint.on('__UPDATE_CYCLE_RES__', onUpdateCycle);

        endpoint.emit('__GET_STATUS__');

        nrInputShim(this, onMessage);

        this.on('close', function (done) {
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener('__UPDATE_CYCLE_RES__', onUpdateCycle);
            done();
        });

    }
    RED.nodes.registerType("df1 control", DF1Control);
    // <End> --- DF1 Control
};
