///<reference path='../quby.ts' />

"use strict";

/**
 * quby.core
 * 
 * This is the guts of the Quby parser,
 * which binds the rest of it together.
 * 
 * It includes the internal parser,
 * the verifier, and the printing mechanism.
 * 
 * It's mostly stuff that doesn't really
 * belong in main (because that is public),
 * whilst not really belonging in any other
 * section.
 */
module quby.core {
    var STATEMENT_END = ';\n';

    export interface ITimeResult {
        parseCompile: number;
        parseSymbols: number;
        parseRules: number;
        parseTotal: number;

        validatorTotal: number;
        total: number;
    }

    function newTimeResult( parseTime: parse.ITimeResult, validateTime: number, totalTime: number ): ITimeResult {
        return {
            parseCompile: parseTime.compile,
            parseSymbols: parseTime.symbols,
            parseRules: parseTime.rules,
            parseTotal: parseTime.total,

            validatorTotal: validateTime,

            total: totalTime
        };
    }

    export interface IDebugCallback {
        ( t: ITimeResult ): void;
    }

    /**
     * An interface for objects, so we can use them as maps.
     */
    export interface IMapObj<T> {
        [key: string]: T;
    }

    function handleError(errHandler: (err: Error) => void , err: Error, throwErr:boolean = true) {
        if (errHandler !== null) {
            errHandler(err);
        }

        if (throwErr) {
            throw err;
        }
    }

    /**
     * This is the point that joins together
     * quby.main to quby.core.
     *
     * Given a quby.main.ParserInstance, and a
     * quby.core.Validator, this will run the
     * actual parse process and pump the results
     * through the validator.
     *
     * It accesses the internal properties of
     * objects freely, because this is to hide
     * their access from teh public API (namely
     * the ParserInstance).
     */
    export function runParser(instance:quby.main.ParserInstance, validator: Validator, errHandler:(err:Error) => void) {
        instance.lock();

        var debugFun = instance.getDebugFun();
        var start = Date.now();

        quby.parser.parseSource(
                instance.getSource(),
                instance.getName(),

            function ( program: quby.ast.ISyntax, errors: parse.IParseError[], parserTime: parse.ITimeResult ) {
                    var validateStart = Date.now();

                    validator.errorHandler( errHandler );
                    validator.adminMode( instance.isAdmin() );
                    validator.strictMode( instance.isStrict() );

                    try {
                        validator.validate(program, errors);
                    } catch (err) {
                        handleError( errHandler, err );
                    }

                    var callback = instance.getFinishedFun();
                    var validateTime = Date.now() - validateStart;
                    var totalTime = Date.now() - start;

                    if ( debugFun ) {
                        debugFun( newTimeResult( parserTime, validateTime, totalTime ) );
                    }

                    if ( callback ) {
                        util.future.runFun( callback );
                    }
                }
        );
    }

    /**
     * Turns the given error into the output string
     * that should be displayed for the user.
     *
     * You can imagine that this is the checkpoint
     * between whatever internal format we use, and
     * what the outside world is going to see.
     *
     * @param src The source code object used for finding the lines.
     * @param error The error to parse.
     * @return Info on the error, for display purposes.
     */

    export interface IErrorInfo {
        name: string;
        line: number;
        message: string;
        error: string;
    }

    export class Validator {
        private errors: IErrorInfo[];

        /*
         * Used for the script name, for when reporting errors.
         * If a node fails to provide a script name,
         * the name from the last error will
         * be used instead.
         */
        private lastErrorName: string;

        private isStrictModeOn: boolean;
        private isAdminMode: boolean;

        private isParameters: boolean;
        private isFunParameters: boolean;
        private inConstructor: boolean;

        private isBlockArr: boolean[];

        private funCount: number;

        private lateUsedFuns: LateFunctionBinder;
        private currentFun: quby.ast.FunctionDeclaration;
        private currentClass: ClassValidator;
        private rootClass: RootClassProxy;
        private symbols: SymbolTable;

        private classes: IMapObj<quby.core.ClassValidator>;

        private endValidateCallbacks: { (v: Validator): void; }[];

        private preInlines: quby.ast.PreInline[];

        /**
         * Stores scope of variables in general.
         */
        private vars: IMapObj<quby.ast.LocalVariable>[];

        /**
         * Stores scope levels specifically within current function.
         */
        private funVars: IMapObj<quby.ast.LocalVariable>[];

        /**
         * These all bind in the form:
         *  { callname -> Function }
         */
        private funs: IMapObj<quby.ast.IFunctionDeclarationMeta>;
        private calledMethods: IMapObj<quby.ast.IFunctionMeta>;
        private methodNames: FunctionTable;

        private usedFunsStack: quby.ast.FunctionCall[];

        private programs: quby.ast.ISyntax[];

        /**
         * These both hold:
         *  { callName -> GlobalVariable }
         */
        private globals: IMapObj<boolean>;
        private usedGlobals: IMapObj<quby.ast.GlobalVariable>;

        private errHandler: (err: Error) => void;

        constructor() {
            // the various program trees that have been parsed
            this.programs = [];

            this.lastErrorName = null;

            this.isStrictModeOn = true;

            this.classes = {};
            this.currentClass = null;
            this.rootClass = new RootClassProxy();

            this.calledMethods = {};

            this.vars = [];
            this.funVars = [];

            this.isBlockArr = [];

            this.globals = {};
            this.usedGlobals = {};

            this.funs = {};
            this.usedFunsStack = [];

            /**
             * This is a list of every method name in existance,
             * across all code.
             * 
             * This is for printing the empty method stubs,
             * for when no methods are present for a class.
             */
            this.methodNames = new FunctionTable();
            this.lateUsedFuns = new LateFunctionBinder(this);
            this.errors = [];

            this.isParameters = false;
            this.isFunParameters = false;

            this.inConstructor = false;

            this.endValidateCallbacks = [];

            this.preInlines = [];

            // When 0, we are outside of a function's scope.
            // The scope is added when we enter a function declaration.
            // From then on every extra layer of scope increments it further,
            // and every time we move down it is decremented until we exit the function.

            // Why??? When 0, we can scan all layers of this.vars looking for local variables.
            // When greater then 0 we can scan all layers (decrementing on each) until funCount == 0.
            this.funCount = 0;
            this.currentFun = null;
            this.isAdminMode = false;

            this.errHandler = null;

            this.symbols = new SymbolTable();

            this.pushScope();
        }

        errorHandler(errHandler: (err: Error) => void ): void {
            this.errHandler = errHandler;
        }

        strictMode( mode:boolean ) {
            this.isStrictModeOn = mode;
        }

        adminMode( mode:boolean ) {
            this.isAdminMode = mode;
        }

        addPreInline(inline) {
            this.preInlines.push(inline);
        }

        addSymbol( sym:quby.ast.Symbol ) {
            this.symbols.add(sym);
        }

        setInConstructor( inC:boolean ) {
            this.inConstructor = inC;
        }
        isInConstructor() : boolean {
            return this.inConstructor;
        }

        setClass(klass:quby.ast.IClassDeclaration) {
            if (this.currentClass != null) {
                this.parseError(klass.getOffset(), "Class '" + klass.getName() + "' is defined inside '" + this.currentClass.getClass().getName() + "', cannot define a class within a class.");
            }

            var klassName = klass.getCallName();
            var kVal = <ClassValidator> this.classes[klassName];

            if (!kVal) {
                kVal = new ClassValidator(this, klass);
                this.classes[klassName] = kVal;
            } else {
                var oldKlass = kVal.getClass();
                var oldKlassHead = oldKlass.getHeader();
                var klassHead = klass.getHeader();

                // if super relationship is set later in the app
                if (!oldKlassHead.hasSuper() && klassHead.hasSuper()) {
                    oldKlass.setHeader(klassHead);
                } else if ( oldKlassHead.hasSuper() && klassHead.hasSuper() ) {
                    if ( oldKlassHead.getSuperCallName() !== klassHead.getSuperCallName() ) {
                        this.parseError(klass.getOffset(), "Super class cannot be redefined for class '" + klass.getName() + "'.");
                    }
                }
            }

            if (klass.getCallName() === quby.runtime.ROOT_CLASS_CALL_NAME) {
                this.rootClass.setClass(kVal);
            }
            this.lateUsedFuns.setClassVal(kVal);

            return (this.currentClass = kVal);
        }
        getClass(callName:string) {
            return <ClassValidator> this.classes[callName];
        }
        getCurrentClass() {
            return this.currentClass;
        }
        private getRootClass() {
            return this.rootClass;
        }
        unsetClass() {
            this.currentClass = null;
        }
        isInsideClass() : boolean {
            return this.currentClass !== null;
        }
        isInsideExtensionClass(): boolean {
            return this.currentClass !== null && this.currentClass.getClass().isExtensionClass();
        }
        useField(field) {
            this.currentClass.useField(field);
        }
        assignField(field) {
            this.currentClass.assignField(field);
        }
        useThisClassFun(fun) {
            this.currentClass.useFun(fun);
        }

        setParameters(isParameters:boolean, isFun:boolean) {
            this.isParameters = isParameters;
            this.isFunParameters = isFun;
        }

        isInsideParameters() {
            return this.isParameters;
        }
        isInsideFunParameters() {
            return this.isParameters && this.isFunParameters;
        }
        isInsideBlockParameters() {
            return this.isParameters && !this.isFunParameters;
        }

        isInsideClassDeclaration() {
            return this.isInsideClass() && !this.isInsideFun();
        }

        pushScope() {
            this.vars.push({});
            this.isBlockArr.push(false);

            if (this.isInsideFun()) {
                this.funCount++;
            }
        }
        pushFunScope(fun) {
            if (this.currentFun !== null) {
                quby.runtime.error("Fun within Fun", "Defining a function whilst already inside another function.");
            }

            this.currentFun = fun;
            this.funCount++;
            this.vars.push({});
            this.isBlockArr.push(false);
        }
        pushBlockScope() {
            this.pushScope();
            this.isBlockArr[this.isBlockArr.length - 1] = true;
        }

        popScope() {
            this.isBlockArr.pop();

            if (this.isInsideFun()) {
                this.funCount--;

                if (this.funCount <= 0) {
                    var rootFVars = this.vars.pop();

                    for (var i = 0; i < this.funVars.length; i++) {
                        var fVars = this.funVars[i];

                        for (var key in fVars) {
                            if (rootFVars[key] === undefined) {
                                this.currentFun.addPreVariable(fVars[key]);
                            }
                        }
                    }

                    this.currentFun = null;
                    this.funVars = [];
                } else {
                    this.funVars.push(this.vars.pop());
                }
            } else {
                this.vars.pop();
            }
        }

        /**
        * Returns true or false stating if the validator is within a scope
        * somewhere within a function. This could be within the root scope of
        * the function, or within a scope within that.
        *
        * @return True if the validator is within a function, somewhere.
        */
        isInsideFun() {
            return this.currentFun !== null;
        }

        /**
        * Returns true or false stating if the validator is currently inside of
        * a block function.
        *
        * @return True if the validator is inside a block, otherwise false.
        */
        isInsideBlock() {
            return this.isBlockArr[this.isBlockArr.length - 1];
        }

        getCurrentFun() {
            return this.currentFun;
        }
        isConstructor() {
            return this.currentFun !== null && this.currentFun.isConstructor();
        }

        assignVar(variable:quby.ast.LocalVariable) {
            this.vars[this.vars.length - 1][variable.getCallName()] = variable;
        }
        containsVar(variable:quby.ast.LocalVariable) : boolean {
            var id = variable.getCallName();

            var stop:number = this.isInsideFun() ?
                    this.vars.length - this.funCount :
                    0;

            for (var i = this.vars.length - 1; i >= stop; i--) {
                if (this.vars[i][id] !== undefined) {
                    return true;
                }
            }

            return false;
        }
        containsLocalVar(variable:quby.ast.LocalVariable) : boolean {
            var id = variable.getCallName();
            var scope = this.vars[this.vars.length - 1];

            return !!scope[id];
        }
        containsLocalBlock() : boolean {
            var localVars = this.vars[this.vars.length - 1];

            for (var key in localVars) {
                var blockVar = localVars[key];

                if ( blockVar instanceof quby.ast.ParameterBlockVariable ) {
                    return true;
                }
            }

            return false;
        }

        assignGlobal(global:quby.ast.GlobalVariable) {
            this.globals[global.getCallName()] = true;
        }
        useGlobal(global:quby.ast.GlobalVariable) {
            this.usedGlobals[global.getCallName()] = global;
        }

        /**
         * Declares a function.
         *
         * By 'function' I mean function, constructor, method or function-generator.
         *
         * @param func
         */
        defineFun(fun:quby.ast.IFunctionDeclarationMeta) {
            var klass = this.currentClass;

            // Methods / Constructors
            if (klass !== null) {
                // Constructors
                if (fun.isConstructor()) {
                    klass.addNew(fun);
                    // Methods
                } else {
                    klass.addFun(fun);
                    this.methodNames.add(fun.getCallName(), fun.getName());
                }
                // Functions
            } else {
                if (this.funs[fun.getCallName()] !== undefined) {
                    this.parseError(fun.getOffset(), "Function is already defined: '" + fun.getName() + "', with " + fun.getNumParameters() + " parameters.");
                }

                this.funs[fun.getCallName()] = fun;
            }
        }

        /* Store any functions which have not yet been defined.
        * Note that this will include valid function calls which are defined after
        * the call, but this is sorted in the endValidate section. */
        useFun(funCall:quby.ast.FunctionCall) {
            if (funCall.isMethod()) {
                this.calledMethods[funCall.getCallName()] = funCall;
            } else if (this.isInsideClass()) {
                if (this.currentClass.hasFun(funCall)) {
                    funCall.setIsMethod();
                } else {
                    this.lateUsedFuns.addFun(funCall);
                }
            } else if (! this.funs[funCall.getCallName()]) {
                this.usedFunsStack.push(funCall);
            }
        }

        /**
         * Strict Errors are errors which we can live with,
         * and will not impact on the resulting program,
         * but should really be fixed.
         *
         * This is mostly here to smooth over the cracks
         * when breaking changes are made.
         *
         * Old version can stay, and the new one can be
         * enforced as a strict error (presuming that
         * behaviour does not change).
         */
        strictError(lineInfo:parse.Symbol, msg:string) {
            if ( this.isStrictModeOn ) {
                this.parseError(lineInfo, msg);
            }
        }

        parseError(sym:parse.Symbol, msg:string) {
            if (sym) {
                this.parseErrorLine(sym.getLine(), msg, sym.getSource().getName());
            } else {
                this.parseErrorLine(-1, msg);
            }
        }

        parseErrorLine(line:number, error:string, name?:string) {
            if ( line === null || line === undefined ) {
                line = -1;
            }
            line = line | 0;

            if (!name && name !== '') {
                name = this.lastErrorName;
            } else {
                this.lastErrorName = name;
            }

            var msg:string;

            if ( line !== -1 ) {
                msg = "line " + line + ", " + error;
            } else {
                msg = error
            }

            this.errors.push({
                name: name,
                line: line,
                message: msg,
                error: error
            });
        }

        getErrors() : IErrorInfo[] {
            var errors = this.errors;

            if ( errors.length > 0 ) {
                errors.sort( ( a: IErrorInfo, b: IErrorInfo ) => {
                    if (a.name === b.name) {
                        var aLine = a.line;
                        if ( aLine === null ) {
                            aLine = -1;
                        }

                        var bLine = b.line;
                        if ( bLine === null ) {
                            bLine = -1;
                        }

                        return aLine - bLine;
                    } else {
                        return a.name.localeCompare( b.name );
                    }
                });
            }

            return errors;
        }

        hasErrors() : boolean {
            return this.errors.length > 0;
        }

        /**
         * Pass in a function and it will be called by the validator at the
         * end of validation. Note that all other validation occurres before
         * these callbacks are called.
         *
         * These are called in a FIFO order, but bear in mind that potentially
         * anything could have been added before your callback.
         */
        onEndValidate(callback:(v:quby.core.Validator) => void) {
            this.endValidateCallbacks.push(callback);
        }

        /**
         * Validator should no longer be used after this is called.
         * It performs all of the final steps needed on the program and then
         * returns the output code.
         *
         * Note that output code is only returned if the program is valid.
         *
         * If it is not valid, then an empty string is returned. This is
         * done because printing an invalid program will either lead to
         * random errors (validation items being missing during the print),
         * or at best, you will receive an incomplete program with random
         * bits missing (which shouldn't be used).
         */
        finalizeProgram( times: { finalize: number; print: number; }):string {
            var start = Date.now();
            this.endValidate();
            var end = Date.now();

            var finalizeTime = end - start;
            times.finalize = finalizeTime;

            if (this.hasErrors()) {
                return '';
            } else {
                var code = this.generateCode();
                times.print = Date.now() - end;

                return code;
            }
        }

        // adds a program to be validated by this Validator
        validate(program:quby.ast.ISyntax, errors:parse.IParseError[]) {
            // clear this, so errors don't seap across multiple validations
            this.lastErrorName = null;

            if (errors === null || errors.length === 0) {
                if (!program) {
                    // avoid unneeded error messages
                    if (this.errors.length === 0) {
                        this.strictError(null, "No source code provided");
                    }
                } else {
                    try {
                        program.validate(this);

                        this.programs.push(program);
                    } catch (err) {
                        this.parseError(null, 'Unknown issue with your code has caused the parser to crash!');

                        if (window.console && window.console.log) {
                            handleError(this.errHandler, err, false);

                            window.console.log(err);

                            if (err.stack) {
                                window.console.log(err.stack);
                            }
                        }
                    }
                }
            } else {
                for (var i = 0; i < errors.length; i++) {
                    var error = errors[i];
                    this.parseErrorLine( error.line, error.message );
                }
            }
        }

        /**
         * Private.
         *
         * Runs all final validation checks.
         * After this step the program is fully validated.
         * 
         * At the time of writing, Chrome fails to be able to optimize methods which include a try-catch
         * statement. So the statement must be pushed out into an outer method.
         */
        private endValidate() {
            try {
                this.endValidateInner();

            } catch (err) {
                this.parseError(null, 'Unknown issue with your code has caused the parser to crash!');

                if (window.console && window.console.log) {
                    handleError(this.errHandler, err, false);

                    if (err.stack) {
                        window.console.log(err.stack);
                    } else {
                        window.console.log(err);
                    }
                }
            }
        }

        private endValidateInner() {
            /* 
             * Go through all function calls we have stored, which have not been
             * confirmed as being defined. Note this can include multiple calls
             * to the same functions. 
             */
            var funs = this.funs;
            var usedFunsStack = this.usedFunsStack;
            var usedFunsStackKeys = Object.keys( usedFunsStack );

            for ( var i = 0; i < usedFunsStackKeys.length; i++ ) {
                var fun:quby.ast.FunctionCall = usedFunsStack[usedFunsStackKeys[i]];
                var callName = fun.getCallName();

                // check if the function is not defined
                if ( funs[callName] === undefined ) {
                    this.searchMissingFunAndError(fun, funs, 'function');
                }
            }

            /* Check all used globals were assigned to, at some point. */
            var globals = this.globals;
            var usedGlobals = this.usedGlobals;
            var usedGlobalsKeys = Object.keys( usedGlobals );

            for ( var i = 0; i < usedGlobalsKeys.length; i++ ) {
                var strGlobal = usedGlobalsKeys[i];

                if ( globals[strGlobal] === undefined ) {
                    var global = usedGlobals[strGlobal];

                    this.parseError(global.getOffset(), "Global used but never assigned to: '" + global.getName() + "'.");
                }
            }

            /* finalize all classes */
            var classes = this.classes;
            var classesKeys = Object.keys( classes );
            var classesKeysLength = classesKeys.length;

            for ( var i = 0; i < classesKeysLength; i++ ) {
                classes[classesKeys[i]].endValidate();
            }

            /* Ensure all called methods do exist (somewhere) */
            var calledMethods = this.calledMethods;
            var calledMethodKeys = Object.keys( calledMethods );

            for ( var i = 0; i < calledMethodKeys.length; i++ ) {
                var method:quby.ast.IFunctionMeta = calledMethods[calledMethodKeys[i]];
                var methodFound = false;

                for ( var j = 0; j < classesKeysLength; j++ ) {
                    if (classes[classesKeys[j]].hasFun(method)) {
                        methodFound = true;
                        break;
                    }
                }

                if ( ! methodFound ) {
                    var found:quby.ast.IFunctionDeclarationMeta = this.searchForMethodLike(method),
                        name = method.getName().toLowerCase(),
                        errMsg:string = null;

                    if (found !== null) {
                        if ( !found.hasDeclarationError() ) {
                            if ( name === found.getName().toLowerCase() ) {
                                errMsg = "Method '" + method.getName() + "' called with incorrect number of parameters, " + method.getNumParameters() + " instead of " + found.getNumParameters();
                            } else {
                                errMsg = "Method '" + method.getName() + "' called with " + method.getNumParameters() + " parameters, but is not defined in any class. Did you mean: '" + found.getName() + "'?";
                            }
                        }
                    } else {
                        // no alternative method found
                        errMsg = "Method '" + method.getName() + "' called with " + method.getNumParameters() + " parameters, but is not defined in any class.";
                    }

                    this.parseError(method.getOffset(), errMsg);
                }
            }

            this.lateUsedFuns.endValidate(this.funs);

            // finally run the callbacks
            for ( var i = 0; i < this.endValidateCallbacks.length; i++ ) {
                this.endValidateCallbacks[i]( this );
            }
            this.endValidateCallbacks = [];
        }

        /**
         * Turns all stored programs into
         */
        generateCode() {
            try {
                var printer = new Printer();

            printer.setCodeMode( false );
            this.generatePreCode( printer );
                printer.setCodeMode(true);

                for (var i = 0; i < this.programs.length; i++) {
                    this.programs[i].print(printer);
                }
            } catch (err) {
                handleError(this.errHandler, err);
            }

            return printer.toString();
        }

        generateNoSuchMethodStubs(p:Printer) {
            // generate the noSuchMethod function stubs
            if (!quby.compilation.hints.useMethodMissing()) {
                var
                    rootKlass = this.getRootClass().getClass(),
                    callNames:string[] = [],
                    extensionStr:string[] = [];

                p.append('var ', quby.runtime.FUNCTION_DEFAULT_TABLE_NAME, "={");

                var errFun = ":function(){quby_errFunStub(this,arguments);}";
                var printComma = false;
                this.methodNames.callNames((callName: string) => {
                    if (
                            rootKlass === null ||
                            !rootKlass.hasFunCallName(callName)
                    ) {
                        // from second iteration onwards, this if is called
                        if (printComma) {
                            p.append(',', callName, ':function(){noSuchMethodError(this,"' + callName + '");}');
                            // this else is run on first iteration
                        } else {
                            p.append(callName, ':function(){noSuchMethodError(this,"' + callName + '");}');
                            printComma = true;
                        }

                        callNames[callNames.length] = callName;
                        extensionStr[extensionStr.length] = ['.prototype.', callName, '=', quby.runtime.FUNCTION_DEFAULT_TABLE_NAME, '.', callName].join('');
                    }
                });

                p.append("}");
                p.endStatement();

                // print empty funs for each Extension class
                var classes = quby.runtime.CORE_CLASSES;
                var numNames = callNames.length;
                for (var i = 0; i < classes.length; i++) {
                    var name = classes[i];
                    var transName = quby.runtime.translateClassName(name);
                    var thisKlass = this.getClass(name);

                    for (var j = 0; j < callNames.length; j++) {
                        var callName = callNames[j];

                        if (thisKlass === undefined || !thisKlass.hasFunCallName(callName)) {
                            p.append(transName, extensionStr[j]);
                            p.endStatement();
                        }
                    }
                }

                if (rootKlass !== null) {
                    rootKlass.setNoMethPrintFuns(callNames);
                }
            }
        }

        /*
         * Of all the things this does, it also prints out the methods which
         * classes inherit from the QubyObject (as this is the parent of all
         * objects).
         */
        generatePreCode(p:Printer) {
            this.methodNames.print(p);
            this.symbols.print(p);
            p.printArray(this.preInlines);

            this.generateNoSuchMethodStubs(p);

            // print the Object functions for each of the extension classes
            var classes = quby.runtime.CORE_CLASSES;
            var stmts = this.rootClass.getPrintStmts();

            if ( stmts !== null ) {
                for ( var i = 0; i < classes.length; i++ ) {
                    var name = classes[i];

                    p.appendExtensionClassStmts( name, stmts );
                }
            }
        }

        /* Validation Helper Methods */

        ensureInConstructor(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(!this.isInsideFun() || !this.isInsideClass() || !this.isConstructor(), syn, errorMsg);
        }
        ensureInMethod(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(!this.isInsideFun() || !this.isInsideClass(), syn, errorMsg);
        }
        ensureAdminMode(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(!this.isAdminMode, syn, errorMsg);
        }
        ensureInFun(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(!this.isInsideFun(), syn, errorMsg);
        }
        ensureOutFun(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(this.isInsideFun(), syn, errorMsg);
        }
        ensureOutBlock(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(this.isInsideBlock(), syn, errorMsg);
        }
        ensureInClass(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(!this.isInsideClass(), syn, errorMsg);
        }
        ensureOutClass(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(this.isInsideClass(), syn, errorMsg);
        }
        ensureOutParameters(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(this.isInsideParameters(), syn, errorMsg);
        }
        ensureOutFunParameters(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(this.isInsideFunParameters(), syn, errorMsg);
        }
        ensureInFunParameters(syn:quby.ast.ISyntax, errorMsg:string) {
            return this.ensureTest(!this.isInsideFunParameters(), syn, errorMsg);
        }
        ensureTest(errCondition: boolean, syn:quby.ast.ISyntax, errorMsg:string):boolean {
            if (errCondition) {
                this.parseError(syn.offset, errorMsg);
                return false;
            } else {
                return true;
            }
        }

        /**
         * Searches through all classes,
         * for a method which is similar to the one given.
         *
         * @param method The method to search for one similar too.
         * @param klassVal An optional ClassValidator to restrict the search, otherwise searches through all classes.
         */
        searchForMethodLike(method:quby.ast.IFunctionMeta, klassVal?:ClassValidator):quby.ast.IFunctionDeclarationMeta {
            if (klassVal) {
                return this.searchMissingFun(method, klassVal.getFunctions());
            } else {
                var searchKlassVals = this.classes,
                    altMethod:quby.ast.IFunctionDeclarationMeta = null,
                    methodName = method.getName().toLowerCase();
                // check for same method, but different number of parameters

                for (var i in searchKlassVals) {
                    var found = this.searchMissingFunWithName(methodName, searchKlassVals[i].getFunctions());

                    if (found !== null) {
                        // wrong number of parameters
                        if (found.getName().toLowerCase() === methodName) {
                            return found;
                            // alternative name
                        } else if (altMethod === null) {
                            altMethod = found;
                        }
                    }
                }

                return altMethod;
            }
        }

        /**
         * Note that this uses name, and not callName!
         *
         * 'incorrect parameters' comes first, and takes priority when it comes to being returned.
         * 'alternative name' is returned, only if 'incorrect parameters' does not come first.
         * Otherwise null is returned.
         */
        searchMissingFunWithName(name:string, searchFuns:IMapObj<quby.ast.IFunctionDeclarationMeta>):quby.ast.IFunctionDeclarationMeta {
            var altNames:string[] = [],
                altFun:quby.ast.IFunctionDeclarationMeta = null;
            var nameLen = name.length;

            if (
                    nameLen > 3 &&
                    (name.indexOf('get') === 0 || name.indexOf('set') === 0)

            ) {
                altNames.push(name.substr(3));
            } else {
                altNames.push('get' + name);
                altNames.push('set' + name);
            }

            var keys = Object.keys( searchFuns );
            var keysLen = keys.length;
            for ( var i = 0; i < keysLen; i++ ) {
                var funIndex = keys[i];

                var searchFun = searchFuns[funIndex];
                var searchName = searchFun.getName().toLowerCase();

                if (searchName === name) {
                    return searchFun;
                } else if (altFun === null) {
                    for (var j = 0; j < altNames.length; j++) {
                        var altName = altNames[j];

                        if (searchName === altName) {
                            altFun = searchFun;
                            break;
                        }
                    }
                }
            }

            return altFun;
        }

        searchMissingFun(fun:quby.ast.IFunctionMeta, searchFuns:IMapObj<quby.ast.IFunctionDeclarationMeta>) : quby.ast.IFunctionDeclarationMeta {
            return this.searchMissingFunWithName(fun.getName().toLowerCase(), searchFuns);
        }

        /**
         *
         */
        searchMissingFunAndError(fun:quby.ast.IFunctionMeta, searchFuns:IMapObj<quby.ast.IFunctionDeclarationMeta>, strFunctionType:string) {
            var name = fun.getName(),
                lower = name.toLowerCase(),
                found = this.searchMissingFunWithName(name, searchFuns),
                errMsg:string;

            if (found !== null) {
                if (lower === found.getName().toLowerCase()) {
                    errMsg = "Called " + strFunctionType + " '" + name + "' with wrong number of parameters.";
                } else {
                    errMsg = "Called " + strFunctionType + " '" + name + "', but it is not defined, did you mean: '" + found.getName() + "'.";
                }
            } else {
                errMsg = "Undefined " + strFunctionType + " called: '" + name + "'.";
            }

            this.parseError(fun.offset, errMsg);
        }
    }

    /**
     * Here is some example code:
     * class Foo
     *     def bar()
     *         foobar()
     *     end
     * end
     *
     * How do we know if 'foobar' is a call to a method or a function?
     * We don't! But this, class works it out, during 'endValidate'.
     */
    class LateFunctionBinder {
        private validator: Validator;

        private classVals: IMapObj<quby.core.ClassValidator>;
        private classFuns: IMapObj<IMapObj<quby.ast.FunctionCall[]>>;

        private currentClassV: ClassValidator = null;

        constructor(validator: Validator) {
            this.validator = validator;

            this.classVals = {};
            this.classFuns = {};
        }

        setClassVal(klass:ClassValidator) {
            this.currentClassV = klass;
        }

        addFun(fun:quby.ast.FunctionCall) {
            var callName = this.currentClassV.getClass().getCallName();
            var funs = this.classFuns[callName];

            if (!funs) {
                funs = {};
                this.classFuns[callName] = funs;
                this.classVals[callName] = this.currentClassV;
            }

            var funCallName = fun.getCallName(),
                innerFuns = funs[funCallName];

            if (!innerFuns) {
                innerFuns = [];
                funs[funCallName] = innerFuns;
            }

            innerFuns.push(fun);
        }

        endValidate(globalFuns:IMapObj<quby.ast.IFunctionMeta>) {
            var classFuns = this.classFuns;
            var classVals = this.classVals;
            var classValsKeys = Object.keys( classVals );

            for ( var i = 0; i < classValsKeys.length; i++ ) {
                var className = classValsKeys[i];
                var klassV    = classVals[className];
                var funs      = classFuns[className];
                var funsKeys  = Object.keys( funs );

                for ( var j = 0; j < funsKeys.length; j++ ) {
                    var funName = funsKeys[j];
                    var innerFuns:quby.ast.FunctionCall[] = funs[funName];
                    var fun = innerFuns[0];

                    if (klassV.hasFunInHierarchy(fun)) {
                        for (var k = 0; k < innerFuns.length; k++) {
                            innerFuns[k].setIsMethod();
                        }
                    } else if (!globalFuns[funName]) {
                        for (var k = 0; k < innerFuns.length; k++) {
                            var f = innerFuns[k];

                            this.validator.parseError( f.getOffset(),
                                    "Undefined function '" + f.getName() +
                                    "' called with " + f.getNumParameters() + " parameters," +
                                    " but is not defined in this class or as a function."
                            );
                        }
                    }
                }
            }
        }
    }

    /**
     * Used to store callName to display name mappings for all functions
     * and methods.
     *
     * This is used at runtime to allow it to lookup functions that
     * have been called but don't exist on the object.
     */
    class FunctionTable {
        private funs: IMapObj<string>;
        private size: number;

        constructor() {
            this.funs = {};
            this.size = 0;
        }

        add(callName: string, displayName: string) {
            this.funs[callName] = displayName;
            this.size++;
        }

        callNames( callback : (callName:string) => void ) {
            for ( var callName in this.funs ) {
                callback( callName );
            }
        }

        print(p: Printer) {
            var fs = this.funs;

            p.append('var ', quby.runtime.FUNCTION_TABLE_NAME, '={');

            // We print a comma between each entry
            // and we achieve this by always printing it before the next item,
            // except on the first one!
            var printComma = false;
            for (var callName in fs) {
                if (fs.hasOwnProperty(callName)) {
                    var name: string = fs[callName];

                    // from second iteration onwards, this if is called
                    if (printComma) {
                        p.append(',', callName, ":'", name, "'");
                        // this else is run on first iteration
                    } else {
                        p.append(callName, ":'", name, "'");
                        printComma = true;
                    }
                }
            }

            p.append('}');
            p.endStatement();
        }
    }

    /**
     * This table is used for the symbol mappings.
     * Symbols are the :symbol code you can use in Quby/Ruby.
     *
     * This is printed into the resulting code for use at runtime.
     */
    class SymbolTable {
        private symbols: IMapObj<string>;

        constructor() {
            this.symbols = {};
        }

        add(sym: quby.ast.Symbol) {
            this.symbols[sym.getCallName()] = sym.getMatch();
        }

        print(p: Printer) {
            for (var callName in this.symbols) {
                var sym:string = this.symbols[callName];

                p.append('var ', callName, " = '", sym, "'");
                p.endStatement();
            }
        }
    }

    /**
     * Whilst validating sub-classes will want to grab the root class.
     * If it has not been hit yet then we can't return it.
     * So instead we use a proxy which always exists.
     *
     * This allows us to set the root class later.
     */
    class RootClassProxy {
        private rootClass: ClassValidator;

        constructor() {
            this.rootClass = null;
        }

        setClass(klass:ClassValidator) {
            if (this.rootClass === null) {
                this.rootClass = klass;
            }
        }

        getClass():quby.core.ClassValidator {
            return this.rootClass;
        }

        /**
         * Should only be called after validation (during printing).
         * 
         * todo: this should be moved so it's neater
         */
        getPrintStmts() : quby.ast.ISyntax[] {
            if (this.rootClass === null) {
                return null;
            } else {
                var statements:quby.ast.Statements = this.rootClass.getClass().getStatements();

                if ( statements !== null ) {
                    return statements.getStmts();
                } else {
                    return null;
                }
            }
        }
    }

    export class ClassValidator {
        private isPrinted: boolean;

        private validator: Validator;
        private klass:quby.ast.IClassDeclaration;

        private funs: IMapObj<quby.ast.IFunctionDeclarationMeta>;
        private usedFuns: IMapObj<quby.ast.IFunctionMeta>;
        private news : quby.ast.IFunctionMeta[];

        private usedFields: IMapObj<quby.ast.FieldVariable>;
        private assignedFields: IMapObj<quby.ast.FieldVariable>;

        private noMethPrintFuns: string[];

        constructor(validator: Validator, klass:quby.ast.IClassDeclaration) {
            this.isPrinted = false;

            this.validator = validator;
            this.klass = klass;

            this.funs = {};
            this.usedFuns = {};
            this.news = [];

            this.usedFields = {};
            this.assignedFields = {};

            this.noMethPrintFuns = null;
        }

        getFunctions() {
            return this.funs;
        }

        getClass() {
            return this.klass;
        }

        useField(field:quby.ast.FieldVariable) {
            this.usedFields[field.getCallName()] = field;
        }
        assignField(field:quby.ast.FieldVariable) {
            this.assignedFields[field.getCallName()] = field;
        }
        hasField(field:quby.ast.FieldVariable) {
            var fieldCallName = quby.runtime.formatField(
                    this.klass.getName(),
                    field.getName()
            );

            return this.hasFieldCallName(fieldCallName);
        }
        hasFieldCallName(callName: string) {
            return this.assignedFields[callName] !== undefined;
        }

        addFun(fun:quby.ast.IFunctionDeclarationMeta) {
            var index = fun.getCallName();

            if (this.funs.hasOwnProperty(index)) {
                this.validator.parseError(fun.offset, "Duplicate method '" + fun.getName() + "' declaration in class '" + this.klass.getName() + "'.");
            }

            this.funs[index] = fun;
        }
        hasFunInHierarchy(fun:quby.ast.IFunctionMeta): boolean {
            if (this.hasFun(fun)) {
                return true;
            } else {
                var parentName = this.klass.getSuperCallName();

                // if has a parent class, pass the call on to that
                if ( parentName !== null ) {
                    var parentVal = this.validator.getClass( parentName );

                    if ( parentVal !== undefined ) {
                        return parentVal.hasFunInHierarchy(fun);
                    } else {
                        return false;
                    }
                } else {
                    return false;
                }
            }
        }

        /**
         * States if this class has the given function or not.
         *
         * Ignores parent classes.
         */
        hasFun(fun:quby.ast.IFunctionMeta) {
            return this.hasFunCallName(fun.getCallName());
        }

        /**
         * States if this class has a method with the given call name, or not.
         *
         * Ignores parent classes.
         */
        hasFunCallName(callName: string) {
            return this.funs.hasOwnProperty(callName);
        }
        useFun(fun:quby.ast.IFunctionMeta) {
            var callName = fun.getCallName();

            if (!this.funs[callName]) {
                this.usedFuns[callName] = fun;
            }
        }

        getFun(callName: string) {
            var f = this.funs[callName];
            return (f === undefined) ? null : f;
        }

        addNew(fun:quby.ast.IFunctionMeta) {
            var index = fun.getNumParameters();

            if (this.news[index] !== undefined) {
                this.validator.parseError(fun.offset, "Duplicate constructor for class '" + this.klass.getName() + "' with " + index + " parameters.");
            }

            this.news[index] = fun;
        }

        eachConstructor(callback: (i: number, c: quby.ast.Constructor) => void ) : void {
            var news = this.news;

            for (var i = 0, len = news.length; i < len; i++) {
                var c;

                if ((c = news[i]) !== undefined) {
                    callback(i, c);
                }
            }
        }

        /**
         * Returns an array containing all of the number of
         * parameters, that this expects.
         */
        getNewParameterList(): number[] {
            var news = this.news;

            if (news.length === 0) {
                return [0];
            } else {
                var numParams:number[] = [];

                this.eachConstructor( (i) => numParams.push(i) )

                return numParams;
            }
        }

        hasNew(fun:quby.ast.IFunctionMeta): boolean {
            return this.news[fun.getNumParameters()] !== undefined;
        }
        noNews(): boolean {
            return this.news.length === 0;
        }

        setNoMethPrintFuns( callNames: string[] ) {
            this.noMethPrintFuns = callNames;
        }

        printOnce(p: quby.core.Printer) {
            if (!this.isPrinted) {
                this.isPrinted = true;
                this.print(p);
            }
        }

        /**
        * In practice, this is only ever called by non-extension classes.
        */
        print(p: quby.core.Printer) {
            p.setCodeMode(false);

            var klassName = this.klass.getCallName();
            var superKlass = this.klass.getSuperCallName();

            // class declaration itself
            p.append('function ', klassName, '() {');
            if (superKlass != null) {
                p.append(superKlass, '.apply(this);');
            }
            // set 'this' to '_this'
            p.append('var ', quby.runtime.THIS_VARIABLE, ' = this;');

            if (this.noMethPrintFuns) {
                for (var i = 0; i < this.noMethPrintFuns.length; i++) {
                    var callName = this.noMethPrintFuns[i];

                    p.append('this.', callName, '=', quby.runtime.FUNCTION_DEFAULT_TABLE_NAME, '.', callName);
                    p.endStatement();
                }
            }

            for (var strFun in this.funs) {
                var fun = this.funs[strFun];

                p.append('this.');
                fun.print(p);
                p.endStatement();
            }
            p.append('}');

            // class constructors
            this.eachConstructor( (i, c) => c.print(p) )

            p.setCodeMode(true);
        }

        endValidate() {
            var thisKlass = this.klass;

            // if no constructors, add a default no-args constructor
            // but only for non-core classes
            if (this.news.length === 0 && !this.klass.isExtensionClass()) {
                var constructorObj = new quby.ast.Constructor(
                        thisKlass.offset.clone("new"),
                        null,
                        null
                );
                constructorObj.setClass(thisKlass);

                this.addNew(constructorObj);
            }

            // Check for circular inheritance trees.
            // Travel up the inheritance tree marking all classes we've seen.
            // If we see one we've already seen, then we break with a parse error.
            var seenClasses = {};
            seenClasses[thisKlass.getCallName()] = true;

            var head = thisKlass.getHeader();
            var superClassVs:ClassValidator[] = []; // cache the order of super classes

            var validator = this.validator;

            while (head.hasSuper()) {
                var superKlassV = validator.getClass(head.getSuperCallName());

                if (!superKlassV) {
                    if (!quby.runtime.isCoreClass(head.getSuperName().toLowerCase())) {
                        validator.parseError(thisKlass.offset,
                                "Super class not found: '" +
                                head.getSuperName() +
                                "', for class '" +
                                thisKlass.getName() +
                                "'."
                        );
                    }

                    break;
                } else {
                    var superKlass = superKlassV.getClass();

                    if (seenClasses[superKlass.getCallName()]) {
                        validator.parseError(
                                thisKlass.offset,
                                "Circular inheritance tree is found for class '" + thisKlass.getName() + "'."
                        );

                        break;
                    } else {
                        superClassVs.push(superKlassV);
                        seenClasses[superKlass.getCallName()] = true;
                        head = superKlass.getHeader();
                    }
                }
            }

            // validate fields
            for (var fieldI in this.usedFields) {
                if (this.assignedFields[fieldI] === undefined) {
                    var field = this.usedFields[fieldI];
                    var fieldErrorHandled = false;

                    // search up the super class tree for a field of the same name
                    if (thisKlass.getHeader().hasSuper()) {
                        for (var i = 0; i < superClassVs.length; i++) {
                            var superClassV = superClassVs[i];

                            if (superClassV.hasField(field)) {
                                validator.parseError(field.offset,
                                        "Field '@" +
                                        field.getName() +
                                        "' from class '" +
                                        superClassV.klass.getName() +
                                        "' is accessd in sub-class '" +
                                        thisKlass.getName() +
                                        "', however fields are private to each class."
                                );

                                fieldErrorHandled = true;
                                break;
                            }
                        }
                    }

                    if (!fieldErrorHandled) {
                        validator.parseError(field.offset,
                                "Field '@" +
                                field.getName() +
                                "' is used in class '" +
                                thisKlass.getName() +
                                "' without ever being assigned to."
                        );
                    }
                }
            }

            // Search for funs used on this class.
            // This is more strict then other method checks,
            // as it takes into account that the target is 'this'.
            for (var funName in this.usedFuns) {
                if (!this.funs[funName]) {
                    var fun = this.usedFuns[funName];

                    if (!this.hasFunInHierarchy(fun)) {
                        validator.searchMissingFunAndError(
                                fun, this.funs, thisKlass.getName() + ' method'
                        );
                    }
                }
            }
        }
    }

    /*
     *  \o/ Printing! \o/
     * 
     *           ~ I7I??                        
     *         I++??+++++                       
     *        ,+======++,                       
     *        :~~~~~====~~                      
     *        :~~~~~~~~==:                      
     *        :~~~~~~~~~::::~? :,~:?:           
     *        ::~~~,~::~~~~~~~~~~~~:~~7,        
     *      :::?=~ ~+===~~~~~~~~~~~=~?+7,       
     *     ,=,~,=====+==~~~~~~~~=++==~,7I,      
     *   ~I~II~~~~========~~I+===:::::,7I       
     *  ~:,~??I7,~~~:?I?+===~:::::==+,?~+       
     *  ~::~,=+I77~ +==::::::~======+,I~=       
     *  ::~~~:=++77   ,:~========,,,,,I?:       
     *  ::~~~~,?++    ~~~~~== ,:~=+,=,,~        
     *   ,:~~~:?++   I~~:,,,~=?II7I7II===       
     *   ,:::::=++      ,+III7IIIIIIIIII+=~::   
     *   ,,,:::=++     ==~:7IIIIIIII77777  ~=~  
     *      ,,:~++   ~ ======III7777   ==~~     
     *       ,,~==~~,,,  ,::  ~I    ==:~        
     *         ~:               , =+            
     */

    export class Printer {
        private tempVarCounter: number;

        private isCode: boolean;

        private pre: string[];
        private stmts: string[];
        private preOrStmts: string[];

        private currentPre: IPrinterStatement;
        private currentStmt: IPrinterStatement;
        private current: IPrinterStatement;

        constructor() {
            this.pre = [];
            this.stmts = [];
            this.preOrStmts = this.stmts;

            this.currentPre = newPrinterStatement();
            this.currentStmt = newPrinterStatement();
            this.current = this.currentStmt;

            this.isCode = true;
            this.tempVarCounter = 0;
        }

        getTempVariable(): string {
            return quby.runtime.TEMP_VARIABLE + (this.tempVarCounter++);
        }

        /**
         * Sets this to enter, or more importantly leave, the 'code' printing mode.
         * Code printing is the normal statements, non-code appeares before the code 
         * statements.
         * 
         * Essentially 'setCodeMode(false)' allows you to inject code at the start of 
         * the resulting JS.
         * 
         * @param
         * @return The previous setting for code mode.
         */
        setCodeMode(isCode: boolean) : boolean {
            if ( this.isCode !== isCode ) {
                if ( isCode ) {
                    this.current = this.currentStmt;
                    this.preOrStmts = this.stmts;
                    this.isCode = true;

                    return false;
                } else {
                    this.current = this.currentPre;
                    this.preOrStmts = this.pre;
                    this.isCode = false;

                    return true;
                }
            } else {
                return isCode;
            }
        }

        appendExtensionClassStmts( name: string, stmts: quby.ast.ISyntax[] ) {
            var stmtsStart = quby.runtime.translateClassName( name ) + '.prototype.';


            for ( var i = 0; i < stmts.length; i++ ) {
                var fun = stmts[i];

                // todo this shouldn't need a type check,
                // should be more type safe
                if ( fun['isConstructor'] && ( <any> fun ).isConstructor() ) {
                    fun.print( this );
                } else {
                    this.append( stmtsStart );

                if ( !window['quby_doOnce'] ) {
                    console.log( fun );

                    window['quby_doOnce'] = true;
                }
                    fun.print( this );
                }

                this.endStatement();
            }
        }

        printArray(arr: { print: (p: quby.core.Printer) =>void; }[]) {
            for (
                    var i = 0, len = arr.length;
                    i < len;
                i++
            ) {
                arr[i].print(this);
                this.endStatement();
            }
        }

        flush() {
            this.current.flush( this.preOrStmts );

            return this;
        }

        endStatement() {
            this.current.appendNow( STATEMENT_END );

            return this.flush();
        }

        toString() {
            // finish pre and stmts sections and then concat them out together
            this.currentPre.flush( this.pre );
            this.currentStmt.flush( this.stmts );

            return this.pre.join( '' ) + this.stmts.join( '' );
        }

        /*
         * As a small optimization, no intermediate buffer is needed when
         * appending 'pre'. When 'append' or 'appendPost' they will always
         * show up after 'pre'. So we can just push 'pre' on directly 
         * instead bufferring and flushing it on later.
         */
        appendPre( ...strs: string[] );
        appendPre(a: string) {
            for (var i = 0; i < arguments.length; i++) {
                this.preOrStmts.push( arguments[i] );
            }

            return this;
        }

        append(...strs: string[]);
        append(a: string) {
            for (var i = 0; i < arguments.length; i++) {
                this.current.appendNow(arguments[i]);
            }

            return this;
        }

        appendPost(...strs: string[]);
        appendPost( a: string ) {
            for ( var i = 0; i < arguments.length; i++ ) {
                this.current.appendPost(arguments[i]);
            }

            return this;
        }
    }

    /**
     * This is for working on a single statement at a time.
     * 
     * It allows you to place strings onto the current statement,
     * at the start before the current statement, and append so
     * it always appeares at the end.
     */

    /*
     * This is implemented as an object literal so the method calls
     * are marginally faster. It means the methods are found directly
     * on the object instead of having to go to the prototype.
     */

    interface IPrinterStatement {
        appendNow( e: string ): void;
        appendPost( e: string ): void;
        flush( dest: string[] ): void;
    }

    function newPrinterStatement(): IPrinterStatement {
        return {
            currentLength: 0,
            currentStatement: <string[]>[],

            postLength: 0,
            postStatement: <string[]>[],

            appendNow( e: string ): void {
                this.currentStatement[this.currentLength++] = e;
            },

            appendPost( e: string ): void {
                this.postStatement[this.postLength++] = e;
            },

            flush( dest: string[] ): void {
                var currentLength = this.currentLength;
                var postLength = this.postLength;

                var destI = dest.length;

                if ( currentLength !== 0 ) {
                    var currentStatement = this.currentStatement;
                    for ( var i = 0; i < currentLength; i++ ) { dest[destI++] = currentStatement[i]; }
                    this.currentLength = 0;
                }

                if ( postLength !== 0 ) {
                    var postStatement = this.postStatement;
                    for ( var i = 0; i < postLength; i++ ) { dest[destI++] = postStatement[i]; }
                    this.postLength = 0;
                }
            }
        }
    }
}
