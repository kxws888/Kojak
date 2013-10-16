/* jshint -W083 */

// It's possible I might reuse this instance in multiple contexts some day.

Kojak.Instrumentor = function () {
    this._hasInstrumented = false;
    this._lastCheckpointTime = undefined;

    this._origFunctions = {};
    this._functionProfiles = [];
    this._pakagePaths = [];

    this._stackLevel = -1;
    this._stackLevelCumTimes = {};
    this._stackContexts = [];
};

Kojak.Core.extend(Kojak.Instrumentor.prototype, {

    instrument: function () {
        var candidates;

        try {
            if (this._hasInstrumented) {
                throw 'Code already instrumented';
            }

            this._hasInstrumented = true;

            candidates = this._findFunctionCandidates();
            this._processFunctionCandidates(candidates);
            this._findUniquePakagePaths();

            console.log('Kojak has completed instrumenting.  Run Kojak.Report.instrumentedCode() to see what has been instrumented');
        }
        catch (exception) {
            console.log('Error, Kojak instrument has failed ', exception);
            console.log('Stack:\n', exception.stack);
        }
    },

    hasInstrumented: function(){
        return this._hasInstrumented;
    },


    // Root through all included pakages and find candidate functions
    // These functions might be clazzes or just plain old functions
    //   Keep track of duplicate function references
    //     When there are duplicates if at least one looks like a clazz then assume they will all be used like a clazz
    //     Clazzes are not wrapped at all - anything that might be invoked with the new operator must not be wrapped
    _findFunctionCandidates: function(){
        var candidates = {},
            curPakageNames,
            pakagePath,
            pakage,
            childName,
            child,
            childKojakType;

        curPakageNames = Kojak.Config.getIncludedPackages().slice(0);

        while (curPakageNames.length > 0) {
            pakagePath = curPakageNames.pop();
            pakage = Kojak.Core.getContext(pakagePath);

            if(! this._shouldIgnorePakage(pakagePath, pakage)){
                // Now the pakage can be self aware it's own path
                pakage._kPath = pakagePath;

                // Define the _kPath property so that it is not enumerable.  Otherwise the _kPath might show up incorrectly in iterators
                Object.defineProperty(pakage, '_kPath', {enumerable: false});

                for (childName in pakage) {
                    if (pakage.hasOwnProperty(childName)) {
                        child = pakage[childName];
                        childKojakType = Kojak.Core.inferKojakType(childName, child);

                        if(childKojakType === Kojak.Core.CLASS || childKojakType === Kojak.Core.FUNCTION ){
                            if(!this._shouldIgnoreFunction(pakagePath, childName)){
                                if(!child._kFunctionId){
                                    child._kFunctionId = Kojak.Core.uniqueId();
                                    // Define the _kPath property so that it is not enumerable.  Otherwise the _kPath might show up incorrectly in iterators
                                    Object.defineProperty(child, '_kFunctionId', {enumerable: false});

                                    this._origFunctions[child._kFunctionId] = child;
                                    candidates[child._kFunctionId] = [pakagePath + '.' + childName];
                                }
                                else {
                                    candidates[child._kFunctionId].push(pakagePath + '.' + childName);
                                }
                            }
                        }

                        // A pakage and contain nested pakages or clazzes so recurse on them and check for functions there too
                        if(childKojakType === Kojak.Core.PAKAGE){
                            curPakageNames.push(pakagePath + '.' + childName);
                        }
                        else if(childKojakType === Kojak.Core.CLASS){
                            // Possibly treat a clazz as a possible pakage?
                            curPakageNames.push(pakagePath + '.' + childName);

                            // Check the clazz function's prototype for functions
                            curPakageNames.push(pakagePath + '.' + childName + '.prototype');
                        }
                    }
                }
            }
        }

        return candidates;
    },

    _shouldIgnorePakage: function(pakagePath, pakage){
        if(!pakage){
            return true;
        }
        else if( Kojak.Core.inferKojakType(pakagePath, pakage) === Kojak.Core.PAKAGE && pakage._kPath){
            console.log('ignored circular/duplicate package reference: ', pakagePath);
            return true;
        }
        else {
            return Kojak.Config.isPathExcluded(pakagePath);
        }
    },

    _shouldIgnoreFunction: function(pakagePath, funcName){
        // not sure if this is important
        //name === 'constructor';
        return Kojak.Config.arePathsExcluded(pakagePath, pakagePath + '.' + funcName, funcName);
    },

    _processFunctionCandidates: function(candidates){
        var kFuncId, origFunc, funcPaths, anyClazzes;

        for(kFuncId in candidates){
            funcPaths = candidates[kFuncId];
            origFunc = this._origFunctions[kFuncId];

            if(funcPaths.length === 1){
                // there are no duplicate references to the same function
                if(!this._isFuncAClazz(funcPaths[0])){
                    this._instrumentFunction(funcPaths[0], origFunc);
                }
            }
            else {
                // figure out if any references look like a clazz reference
                // I cannot wrap any function that people expect to use with the new operator - i.e. clazzes
                // If there is even a single clazz I shouldn't wrap any of the functions
                anyClazzes = false;
                funcPaths.forEach(function(fullFuncPath){
                    if(this._isFuncAClazz(fullFuncPath)){
                        anyClazzes = true;
                    }
                }.bind(this));

                if(!anyClazzes){
                    // Each will have it's own independent wrapper that points to the original function
                    funcPaths.forEach(function(fullFuncPath){
                        this._instrumentFunction(fullFuncPath, origFunc);
                    }.bind(this));
                }
            }
        }
    },

    _isFuncAClazz: function(fullFuncPath){
        var funcName, firstChar;

        funcName = fullFuncPath.substring(fullFuncPath.lastIndexOf('.') + 1);
        firstChar = funcName.substring(0, 1);
        return Kojak.Core.isStringOnlyAlphas(firstChar) && firstChar === firstChar.toUpperCase();
    },

    _instrumentFunction: function(fullFuncPath, origFunc){
        var containerPath, container, funcName, funcProfile;

        containerPath = fullFuncPath.substring(0, fullFuncPath.lastIndexOf('.'));
        funcName = fullFuncPath.substring(fullFuncPath.lastIndexOf('.') + 1);

        container = Kojak.Core.getContext(containerPath);

        if(!container){
            console.log('Error, the container missing for function path: ' + fullFuncPath);
        }
        else{
            funcProfile = new Kojak.FunctionProfile(container, funcName, origFunc);
            container[funcName] = funcProfile.getWrappedFunction();
            this._functionProfiles.push(funcProfile);
        }
    },

    _findUniquePakagePaths: function(){
        var uniquePaths = {}, functionKPath, pakagePath, pakagePaths = [];

        this._functionProfiles.forEach(function(functionProfile){
            functionKPath = functionProfile.getKojakPath();
            pakagePath = functionKPath.substring(0, functionKPath.lastIndexOf('.'));

            if(!uniquePaths[pakagePath]){
                uniquePaths[pakagePath] = true;
                pakagePaths.push(pakagePath);
            }
        }.bind(this));

        pakagePaths.sort();

        // these package paths also include clazzes and clazz.prototypes.
    },

    takeCheckpoint: function(){
        if(!this.hasInstrumented()){
            this.instrument();
        }

        this._lastCheckpointTime = new Date();
        this._functionProfiles.forEach(function(functionProfile){
            functionProfile.takeCheckpoint();
        }.bind(this));
    },

    getLastCheckpointTime: function(){
        return this._lastCheckpointTime;
    },

    // Only should be called from FunctionProfile
    recordStartFunction: function (functionProfile) {
        this._stackLevel++;
        this._stackLevelCumTimes[this._stackLevel] = 0;
        this._stackContexts[this._stackLevel] = functionProfile.getKojakPath();

        functionProfile.pushStartTime(new Date(), this._stackContexts.join(' > '));

        if (Kojak.Config.getRealTimeFunctionLogging()) {
            console.log(Kojak.Formatter.makeTabs(this._stackLevel) + 'start: ' + functionProfile.getKojakPath(), Kojak.Formatter.millis(functionProfile.getIsolatedTime()));
        }
    },

    // Only should be called from FunctionProfile
    recordStopFunction: function (functionProfile) {
        var startTime, callTime;

        this._stackLevel--;
        startTime = functionProfile.popStartTime();
        callTime = (new Date()) - startTime;

        functionProfile.addWholeTime(callTime);
        functionProfile.addIsolatedTime(callTime - this._stackLevelCumTimes[this._stackLevel + 1]);
        this._stackLevelCumTimes[this._stackLevel] += callTime;
        this._stackContexts.pop();

        if (Kojak.Config.getRealTimeFunctionLogging()) {
            console.log(Kojak.Formatter.makeTabs(this._stackLevel + 1) + 'stop:  ' + functionProfile.getKojakPath(), Kojak.Formatter.millis(functionProfile.getIsolatedTime()));
        }
    },

    getPackageProfiles: function(){
        return this._packageProfiles;
    },

    getFunctionProfiles: function(){
        return this._functionProfiles;
    }
});