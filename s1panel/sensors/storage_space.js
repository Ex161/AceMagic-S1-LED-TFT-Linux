'use strict';
/*!
 * s1panel - sensor/storage_space
 * GPL-3 Licensed
 */
const fs = require('fs');

const spawn = require('child_process').exec;

const logger = require('../logger');

function read_file(path) {
  
    return new Promise((fulfill, reject) => {

        fs.readFile(path, 'utf8', (err, data) => {
            
            if (err) {
                return reject(err);
            }

            fulfill(data);
        });
    });
}

function file_exists(path) {
    
    return new Promise(fulfill => {

        fs.stat(path, (err, stats) => {

            if (err) {
                return fulfill();
            }

            fulfill(path);
        });
    });
}

function run_command(cmdline) {

    return new Promise((fulfill, reject) => {

        var _runit = spawn(cmdline);
        var _output = '';

        _runit.stdout.on('data', function(data) {

            _output += data;
        });

        _runit.stderr.on('data', function(data) {});

        _runit.on('close', code => {

            return code === 0 ? fulfill(_output) : reject('error executing ' + cmdline);
        });

        _runit.on('error', err => {

            reject(err);
        });
    });
}

function mount_point(dev) {

    return new Promise(fulfill => {
        const _mounts_list = '/proc/mounts';

        file_exists(_mounts_list).then(exists => {

            if (exists) {
                return read_file(_mounts_list);
            } else {
                return new Promise(_ => {
                    reject(_mounts_list + ' does not exist');
                });
            }
        }).then(mounts => {

            var _found = false;

            mounts.split(/\r?\n/).forEach(mount => {
 
                if (!_found && mount) {

                    var _entry = mount.split(/[\s]+/);
                    var _entry_dev = _entry[0];
                    var _entry_m_point = _entry[1];

                    if (_entry_dev == dev) {
                        fulfill(_entry_m_point);
                        _found = true;
                    }
                }
            });

            if (!_found) {
                reject('failed to find mount point for block device ' + dev);
            }
        }, err => {

            reject('failed to read ' + _mounts_list + ': ' + err);
        });
    });
}

function block_dev(m_point) {

    return new Promise(fulfill => {
        const _mounts_list = '/proc/mounts';

        file_exists(_mounts_list).then(exists => {

            if (exists) {
                return read_file(_mounts_list);
            } else {
                return new Promise(_ => {
                    reject(_mounts_list + ' does not exist');
                });
            }
        }).then(mounts => {

            var _found = false;

            mounts.split(/\r?\n/).forEach(mount => {
 
                if (!_found && mount) {

                    var _entry = mount.split(/[\s]+/);
                    var _entry_dev = _entry[0];
                    var _entry_m_point = _entry[1];

                    if (_entry_m_point == m_point) {
                        fulfill(_entry_dev);
                        _found = true;
                    }
                }
            });

            if (!_found) {
                reject('failed to find block device for mount point ' + m_point);
            }
        }, err => {

            reject('failed to read ' + _mounts_list + ': ' + err);
        });
    });
}

function storage_space(m_point) {

    return new Promise(fulfill => {

        var _command_line = 'df -BM --output=size,used,avail ' + m_point;

        run_command(_command_line).then(output => {

            var _lines = output.split(/\r?\n/);

            if (_lines.length > 1) {

                var _data = _lines[1].split(/[\s]+/);
                var _size = _data[1].replace(/M$/, "");
                var _used = _data[2].replace(/M$/, "");
                var _available = _data[3].replace(/M$/, "");

                fulfill({
                    size: parseInt(_size, 10),
                    used: parseInt(_used, 10),
                    available: parseInt(_available, 10)
                });
            }
        }, err => {

            reject(err);
        });
    });
}

function sample(rate, format, config) {

    return new Promise(fulfill => {

        const _private = config._private;

        if (!_private._init_done) return;

        const _diff = Math.floor(Number(process.hrtime.bigint()) / 1000000) - _private._last_sampled;
        var _dirty = false;
        var _last_promise = Promise.resolve();

        if (!_private._last_sampled || _diff > rate) {

            _private._last_sampled = Math.floor(Number(process.hrtime.bigint()) / 1000000);
            _last_promise = storage_space(_private._mount_point);
            _dirty = true;
        }

        _last_promise.then(result => {

            if (result && _dirty) {
                
                var _seconds = _diff / 1000;

                if (!_private._history.length) {

                    for (var i = 0; i < _private._max_points; i++) {
                        _private._history.push(0);
                    }
                } 

                _private._history.push(result.used.toFixed(0));
                _private._history.shift();
                _private._max=result.size.toFixed(0);
            }

            var _max = _private._max;

            const _output = format.replace(/{(\d+)}/g, function (match, number) { 
        
                switch (number) {

                    case '0':
                        return _private._history[_private._history.length - 1];

                    case '1':
                        return _private._history.join();
                        
                    case '2':
                        return "MB";

                    case '3':
                        return _private._mount_point + ' (' + _private._block_dev + ')';

                    case '4':
                        _max = 100;
                        return (_private._max > 0) ?
                               Math.floor(_private._history[_private._history.length - 1] * 100 /
                                          _private._max) : 0;

                    default:
                        return 'null';
                }
            }); 

            fulfill({ value: _output, min: 0, max: _max });
        }, err => {
            if (!_private._fault) {

                logger.error('storage_space: failed to get storage space usage data: ' + err);
                _private._fault = true;
            }
        });
    });
}

function init(config) {

    const _private = {

        _max_points: 10,
        _block_dev: "(root)",
        _mount_point: "/",
        _fault: false,
        _init_done: false,
        _last_sampled: 0,
        _history: [],
        _max: 0
    };
    if (config && config.block_dev) {
        _private._block_dev = config.block_dev;
        mount_point(_private._block_dev).then(mount => {
            _private._mount_point = mount;
            logger.info('storage_space: monitoring partition ' + _private._block_dev +
                        ' mounted at ' + _private._mount_point);
            _private._init_done = true;
        }, err => {
            logger.error('storage_space: ' + err)
            _private._init_done = true;
        });
    } else {
        block_dev(_private._mount_point).then(dev => {
            _private._block_dev = dev;
            logger.info('storage_space: monitoring partition ' + _private._block_dev +
                        ' mounted at ' + _private._mount_point);
            _private._init_done = true;
        }, err => {
            logger.error('storage_space: ' + err)
            _private._init_done = true;
        });
    }

    var _short_dev = _private._block_dev == "(root)" ?
                     "rootfs" :
                     _private._block_dev.replace(/^\/dev\//, "")

    if (config) {
        config._private = _private;
    }

    return 'storage_space_' + _short_dev;
}


module.exports = {
    init,
    sample
};