/// <reference path="../S.d.ts" />

declare var module : { exports : {} };
declare var define : (deps: string[], fn: () => S) => void;

(function () {
    "use strict";
    
    // Public interface
    var S = <S>function S<T>(fn : (v? : T) => T, seed? : T) : () => T {
        var owner  = Owner,
            clock  = RunningClock || RootClock,
            running = RunningNode;

        if (!owner) throw new Error("all computations must be created under a parent computation or root");

        var node = new ComputationNode(clock, fn, seed);
            
        Owner = RunningNode = node;
        
        if (RunningClock) {
            node.value = node.fn!(node.value);
        } else {
            toplevelComputation(node);
        }
        
        if (owner !== UNOWNED) (owner.owned || (owner.owned = [])).push(node);
        
        Owner = owner;
        RunningNode = running;

        return function computation() {
            if (RunningNode) {
                var rclock = RunningClock!,
                    sclock = node.clock;

                while (rclock.depth > sclock.depth + 1) rclock = rclock.parent!;

                if (rclock === sclock || rclock.parent === sclock) {
                    if (node.preclocks) {
                        for (var i = 0; i < node.preclocks.count; i++) {
                            var preclock = node.preclocks.clocks[i];
                            updateClock(preclock);
                        }
                    }

                    if (node.age === node.clock.time()) {
                        if (node.state === RUNNING) throw new Error("circular dependency");
                        else updateNode(node); // checks for state === STALE internally, so don't need to check here
                    }

                    if (node.preclocks) {
                        for (var i = 0; i < node.preclocks.count; i++) {
                            var preclock = node.preclocks.clocks[i];
                            if (rclock === sclock) logNodePreClock(preclock, RunningNode);
                            else logClockPreClock(preclock, rclock, RunningNode);
                        }
                    }
                } else {
                    if (rclock.depth > sclock.depth) rclock = rclock.parent!;

                    while (sclock.depth > rclock.depth + 1) sclock = sclock.parent!;

                    if (sclock.parent === rclock) {
                        logNodePreClock(sclock, RunningNode);
                    } else {
                        if (sclock.depth > rclock.depth) sclock = sclock.parent!;
                        while (rclock.parent !== sclock.parent) rclock = rclock.parent!, sclock = sclock.parent!;
                        logClockPreClock(sclock, rclock, RunningNode);
                    }

                    updateClock(sclock);
                }

                logComputationRead(node, RunningNode);
            }

            return node.value;
        }
    };

    S.root = function root<T>(fn : (dispose? : () => void) => T) : T {
        var owner = Owner,
            root = fn.length === 0 ? UNOWNED : new ComputationNode(RunningClock || RootClock, null, null),
            result : T = undefined!;

        Owner = root;

        try {
            result = fn.length === 0 ? fn() : fn(function _dispose() {
                if (RunningClock) RunningClock.disposes.add(root);
                else dispose(root);
            });
        } finally {
            Owner = owner;
        }

        return result;
    };

    S.on = function on<T>(ev : () => any, fn : (v? : T) => T, seed? : T, onchanges? : boolean) {
        if (Array.isArray(ev)) ev = callAll(ev);
        onchanges = !!onchanges;

        return S(on, seed);
        
        function on(value : T) {
            var running = RunningNode;
            ev(); 
            if (onchanges) onchanges = false;
            else {
                RunningNode = null;
                value = fn(value);
                RunningNode = running;
            } 
            return value;
        }
    };

    function callAll(ss : (() => any)[]) {
        return function all() {
            for (var i = 0; i < ss.length; i++) ss[i]();
        }
    }

    S.data = function data<T>(value : T) : (value? : T) => T {
        var node = new DataNode(RunningClock || RootClock, value);

        return function data(value? : T) : T {
            var rclock = RunningClock!,
                sclock = node.clock;

            if (RunningClock) {
                while (rclock.depth > sclock.depth) rclock = rclock.parent!;
                while (sclock.depth > rclock.depth && sclock.parent !== rclock) sclock = sclock.parent!;
                if (sclock.parent !== rclock)
                    while (rclock.parent !== sclock.parent) rclock = rclock.parent!, sclock = sclock.parent!;

                if (rclock !== sclock) {
                    updateClock(sclock);
                }
            }

            var cclock = rclock === sclock ? sclock! : sclock.parent!;

            if (arguments.length > 0) {
                if (RunningClock) {
                    if (node.pending !== NOTPENDING) { // value has already been set once, check for conflicts
                        if (value !== node.pending) {
                            throw new Error("conflicting changes: " + value + " !== " + node.pending);
                        }
                    } else { // add to list of changes
                        node.pending = value;
                        cclock.changes.add(node);
                        markClockStale(cclock);
                    }
                } else { // not batching, respond to change now
                    if (node.log) {
                        node.pending = value;
                        RootClock.changes.add(node);
                        event();
                    } else {
                        node.value = value;
                    }
                }
                return value!;
            } else {
                if (RunningNode) {
                    logDataRead(node, RunningNode);
                    if (sclock.parent === rclock) logNodePreClock(sclock, RunningNode);
                    else if (sclock !== rclock) logClockPreClock(sclock, rclock, RunningNode);
                }
                return node.value;
            }
        }
    };
    
    S.value = function value<T>(current : T, eq? : (a : T, b : T) => boolean) : S.DataSignal<T> {
        var data  = S.data(current),
            clock = RunningClock || RootClock,
            age   = 0;
        return function value(update? : T) {
            if (arguments.length === 0) {
                return data();
            } else {
                var same = eq ? eq(current, update!) : current === update;
                if (!same) {
                    var time = clock.time();
                    if (age === time) 
                        throw new Error("conflicting values: " + value + " is not the same as " + current);
                    age = time;
                    current = update!;
                    data(update!);
                }
                return update!;
            }
        }
    };

    S.freeze = function freeze<T>(fn : () => T) : T {
        var result : T = undefined!;
        
        if (RunningClock) {
            result = fn();
        } else {
            RunningClock = RootClock;
            RunningClock.changes.reset();

            try {
                result = fn();
                event();
            } finally {
                RunningClock = null;
            }
        }
            
        return result;
    };
    
    S.sample = function sample<T>(fn : () => T) : T {
        var result : T,
            running = RunningNode;
        
        if (running) {
            RunningNode = null;
            result = fn();
            RunningNode = running;
        } else {
            result = fn();
        }
        
        return result;
    }
    
    S.cleanup = function cleanup(fn : () => void) : void {
        if (Owner) {
            (Owner.cleanups || (Owner.cleanups = [])).push(fn);
        } else {
            throw new Error("S.cleanup() must be called from within an S() computation.  Cannot call it at toplevel.");
        }
    };

    S.subclock = function subclock<T>(fn? : () => T) {
        var clock = new Clock(RunningClock || RootClock);

        return fn ? subclock(fn) : subclock;
        
        function subclock<T>(fn : () => T) {
            var result : T = null!,
                running = RunningClock;
            RunningClock = clock;
            clock.state = STALE;
            try {
                result = fn();
                clock.subtime++;
                run(clock);
            } finally {
                RunningClock = running;
            }
            return result;
        }
    }
    
    // Internal implementation
    
    /// Graph classes and operations
    class Clock {
        static count = 0;

        id        = Clock.count++;
        depth     : number;
        age       : number;
        state     = CURRENT;
        subtime   = 0;

        preclocks = null as ClockPreClockLog | null;
        changes   = new Queue<DataNode>(); // batched changes to data nodes
        subclocks = new Queue<Clock>(); // subclocks that need to be updated
        updates   = new Queue<ComputationNode>(); // computations to update
        disposes  = new Queue<ComputationNode>(); // disposals to run after current batch of updates finishes

        constructor(
            public parent : Clock | null
        ) { 
            if (parent) {
                this.age = parent.time();
                this.depth = parent.depth + 1;
            } else {
                this.age = 0;
                this.depth = 0;
            }
        }

        time () {
            var time = this.subtime,
                p = this as Clock;
            while (p = p.parent!) time += p.subtime;
            return time;
        }
    }

    class DataNode {
        pending = NOTPENDING as any;   
        log     = null as Log | null;
        
        constructor(
            public clock : Clock,
            public value : any
        ) { }
    }
    
    class ComputationNode {
        static count = 0;
        
        id        = ComputationNode.count++;
        age       : number;
        state     = CURRENT;
        count     = 0;
        sources   = [] as Log[];
        log       = null as Log | null;
        preclocks = null as NodePreClockLog | null;
        owned     = null as ComputationNode[] | null;
        cleanups  = null as (((final : boolean) => void)[]) | null;
        
        constructor(
            public clock : Clock,
            public fn    : ((v : any) => any) | null,
            public value : any
        ) { 
            this.age = this.clock.time();
        }
    }
    
    class Log {
        count = 0;
        nodes = [] as ComputationNode[];
        ids = [] as number[];
    }

    class NodePreClockLog {
        count     = 0;
        clocks    = [] as Clock[]; // [clock], where clock.parent === node.clock
        ages      = [] as number[]; // clock.id -> node.age
        ucount    = 0; // number of ancestor clocks with preclocks from this node
        uclocks   = [] as Clock[];
        uclockids = [] as number[];
    }

    class ClockPreClockLog {
        count       = 0;
        clockcounts = [] as number[]; // clock.id -> ref count
        clocks      = [] as (Clock | null)[]; // clock.id -> clock 
        ids         = [] as number[]; // [clock.id]
    }
        
    class Queue<T> {
        items = [] as T[];
        count = 0;
        
        reset() {
            this.count = 0;
        }
        
        add(item : T) {
            this.items[this.count++] = item;
        }
        
        run(fn : (item : T) => void) {
            var items = this.items;
            for (var i = 0; i < this.count; i++) {
                fn(items[i]!);
                items[i] = null!;
            }
            this.count = 0;
        }
    }
    
    // Constants
    var NOTPENDING = {},
        CURRENT    = 0,
        STALE      = 1,
        RUNNING    = 2;
    
    // "Globals" used to keep track of current system state
    var RootClock    = new Clock(null),
        RunningClock = null as Clock | null, // currently running clock 
        RunningNode  = null as ComputationNode | null, // currently running computation
        Owner        = null as ComputationNode | null; // owner for new computations

    // Constants
    var REVIEWING  = new ComputationNode(RootClock, null, null),
        DEAD       = new ComputationNode(RootClock, null, null),
        UNOWNED    = new ComputationNode(RootClock, null, null);
    
    // Functions
    function logRead(from : Log, to : ComputationNode) {
        var id = to.id,
            node = from.nodes[id];
        if (node === to) return; // already logged
        if (node !== REVIEWING) from.ids[from.count++] = id; // not in ids array
        from.nodes[id] = to;
        to.sources[to.count++] = from;
    }

    function logDataRead(data : DataNode, to : ComputationNode) {
        if (!data.log) data.log = new Log();
        logRead(data.log, to);
    }
    
    function logComputationRead(node : ComputationNode, to : ComputationNode) {
        if (!node.log) node.log = new Log();
        logRead(node.log, to);
    }

    function logNodePreClock(clock : Clock, to : ComputationNode) {
        if (!to.preclocks) to.preclocks = new NodePreClockLog();
        else if (to.preclocks.ages[clock.id] === to.age) return;
        to.preclocks.ages[clock.id] = to.age;
        to.preclocks.clocks[to.preclocks.count++] = clock;
    }
    
    function logClockPreClock(sclock : Clock, rclock : Clock, rnode : ComputationNode) {
        var clocklog = rclock.preclocks || (rclock.preclocks = new ClockPreClockLog()),
            nodelog = rnode.preclocks || (rnode.preclocks = new NodePreClockLog());

        if (nodelog.ages[sclock.id] === rnode.age) return;

        nodelog.ages[sclock.id] = rnode.age;
        nodelog.uclocks[nodelog.ucount] = rclock;
        nodelog.uclockids[nodelog.ucount++] = sclock.id;

        var clockcount = clocklog.clockcounts[sclock.id];
        if (!clockcount) {
            if (clockcount === undefined) clocklog.ids[clocklog.count++] = sclock.id;
            clocklog.clockcounts[sclock.id] = 1;
            clocklog.clocks[sclock.id] = sclock;
        } else {
            clocklog.clockcounts[sclock.id]++;
        }
    }
    
    function event() {
        RootClock.subtime++;
        try {
            run(RootClock);
        } finally {
            RunningClock = Owner = RunningNode = null;
        }
    }
    
    function toplevelComputation<T>(node : ComputationNode) {
        RunningClock = RootClock;
        RootClock.changes.reset();

        try {
            node.value = node.fn!(node.value);
    
            if (RootClock.changes.count > 0 || RootClock.subclocks.count > 0 || RootClock.updates.count > 0) {
                RootClock.subtime++;
                run(RootClock);
            }
        } finally {
            RunningClock = Owner = RunningNode = null;
        }
    }
        
    function run(clock : Clock) {
        var running = RunningClock,
            count = 0;
            
        clock.disposes.reset();
        
        // for each batch ...
        while (clock.changes.count > 0 || clock.subclocks.count > 0 || clock.updates.count > 0) {
            if (count > 0) // don't tick on first run, or else we expire already scheduled updates
                clock.subtime++;

            clock.changes.run(applyDataChange);
            clock.subclocks.run(updateClock);
            clock.updates.run(updateNode);
            clock.disposes.run(dispose);

            // if there are still changes after excessive batches, assume runaway            
            if (count++ > 1e5) {
                throw new Error("Runaway clock detected");
            }
        }
    }
    
    function applyDataChange(data : DataNode) {
        data.value = data.pending;
        data.pending = NOTPENDING;
        if (data.log) markComputationsStale(data.log);
    }
    
    function markComputationsStale(log : Log) {
        var nodes = log.nodes, 
            ids   = log.ids,
            dead  = 0;
            
        for (var i = 0; i < log.count; i++) {
            var id = ids[i],
                node = nodes[id];
            
            if (node === REVIEWING) {
                nodes[id] = DEAD;
                dead++;
            } else {
                var time = node.clock.time();
                if (node.age < time) {
                    node.age = time;
                    node.state = STALE;
                    node.clock.updates.add(node);
                    markClockStale(node.clock);
                    if (node.owned) markOwnedNodesForDisposal(node.owned);
                    if (node.log) markComputationsStale(node.log);
                }
                
                if (dead) ids[i - dead] = id;
            } 
        }
        
        if (dead) log.count -= dead;
    }

    function markOwnedNodesForDisposal(owned : ComputationNode[]) {
        for (var i = 0; i < owned.length; i++) {
            var child = owned[i];
            child.age = child.clock.time();
            child.state = CURRENT;
            if (child.owned) markOwnedNodesForDisposal(child.owned);
        }
    }

    function markClockStale(clock : Clock) {
        var time = 0;
        if ((clock.parent && clock.age < (time = clock.parent!.time())) || clock.state === CURRENT) {
            clock.state = STALE;
            if (clock.parent) {
                clock.age = time;
                clock.parent.subclocks.add(clock);
                markClockStale(clock.parent);
            }
        }
    }
    
    function updateClock(clock : Clock) {
        var time = clock.parent!.time();
        if (clock.age < time || clock.state === STALE) {
            if (clock.age < time) clock.state = CURRENT;
            if (clock.preclocks) {
                for (var i = 0; i < clock.preclocks.ids.length; i++) {
                    var preclock = clock.preclocks.clocks[clock.preclocks.ids[i]];
                    if (preclock) updateClock(preclock);
                }
            }
            clock.age = time;
        }

        if (clock.state === RUNNING) {
            throw new Error("clock circular reference");
        } else if (clock.state === STALE) {
            clock.state = RUNNING;
            run(clock);
            clock.state = CURRENT;
        }
    }

    function updateNode<T>(node : ComputationNode) {
        if (node.state === STALE) {
            var owner = Owner,
                running = RunningNode,
                clock = RunningClock;
        
            Owner = RunningNode = node;
            RunningClock = node.clock;
        
            node.state = RUNNING;
            cleanup(node, false);
            node.value = node.fn!(node.value);
            node.state = CURRENT;
            
            Owner = owner;
            RunningNode = running;
            RunningClock = clock;
        }
    }
        
    function cleanup(node : ComputationNode, final : boolean) {
        var sources   = node.sources,
            cleanups  = node.cleanups,
            owned     = node.owned,
            preclocks = node.preclocks;
            
        if (cleanups) {
            for (var i = 0; i < cleanups.length; i++) {
                cleanups[i](final);
            }
            node.cleanups = null;
        }
        
        if (owned) {
            for (var i = 0; i < owned.length; i++) {
                dispose(owned[i]);
            }
            node.owned = null;
        }
        
        for (var i = 0; i < node.count; i++) {
            sources[i]!.nodes[node.id] = REVIEWING;
            sources[i] = null!;
        }
        node.count = 0;

        if (preclocks) {
            for (i = 0; i < preclocks.count; i++) {
                preclocks.clocks[i] = null!;
            }
            preclocks.count = 0;

            for (i = 0; i < preclocks.ucount; i++) {
                var upreclocks = preclocks.uclocks[i].preclocks!,
                    uclockid   = preclocks.uclockids[i];
                if (--upreclocks.clockcounts[uclockid] === 0) {
                    upreclocks.clocks[uclockid] = null;
                }
            }
            preclocks.ucount = 0;
        }
    }
        
    function dispose(node : ComputationNode) {
        node.fn       = null;
        node.log      = null;
        node.preclocks = null;
        
        cleanup(node, true);
    }
    
    // UMD exporter
    /* globals define */
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = S; // CommonJS
    } else if (typeof define === 'function') {
        define([], function () { return S; }); // AMD
    } else {
        (eval || function () {})("this").S = S; // fallback to global object
    }
})();