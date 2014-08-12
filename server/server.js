var ldap = require('ldapjs');
var mongoose = require('mongoose');
// var acl = require('mongoose-acl');
var fs = require('fs');
var User = require('./models/user.js');
var Group = require('./models/group.js');

var bunyan = require('bunyan');

var sprintf = require('sprintf');
var ssha = require('ssha');
var rand = require('generate-key');
var config = require('./config.json');

var log = bunyan.createLogger({
  name: "ldap",
  streams: [
    { path: "server.log" },
    { stream: process.stdout, level : "trace" }
  ],
  level: "debug"
});

var dbhost = process.env.DB_PORT_27017_TCP_ADDR || "127.0.0.1",
    dbport = process.env.DB_PORT_27017_TCP_PORT || 27017,
    dbname = new String(process.env.DB_NAME || "/feta/db").replace(/\//g,"");
var dsn = sprintf("mongodb://%s:%s/%s",dbhost,dbport,dbname);
mongoose.connect(dsn);

// create the ldap server
var server = ldap.createServer(log);

var pre = [authorize];
var org = config.organization;
if ( process.env.NODE_ENV == undefined ) var port = 8000;
else var port = config.listen || 389;

/**
 * No anonymous searches allowed right now
 **/
function authorize( req, res, next ) {
  if ( !req.connection.ldap.bindDN ) return next(new ldap.InsufficientAccessRightsError());
  return next();
}

// this is in the nature of the old rootdn rootpw combo
function __admin_bind( req, res, next ) {
  var binddn = req.dn.toString();
  var bindable = new RegExp("(?=())");
}

server.bind(config.basedn, function( req, res, next) {
  var binddn = req.dn.toString();
  // test to make sure the request comes from a bindable object
  var bindable = new RegExp("(?=(ou=(users|services)," + config.basedn + "$))");
  if ( !bindable.test(binddn) ) {
    err = new ldap.InvalidCredentialsError();
    log.info(err);
    return next(err);
  }
  var requser = req.dn.rdns[0];
  var reqcred = req.credentials;
  // now accepting cn and uid logins (to accomodate services)
  var uid = requser.uid || requser.cn;
  log.info("binding as: " + binddn);
  User.find( { uid: uid } , function(err,users) {
    if ( err ) { log.alert(err); return next(err); }
    else {
      log.info("Checking credentials now");
      if ( ssha.verify(reqcred, users[0].password) ) {
        log.info("bind successful.. processing next part of request");
        res.end();
        return next();
      }
    }
    err = new ldap.InvalidCredentialsError();
    log.info(err);
    return next(err);
  });

});

// server user add method
server.add('ou=users,' + config.basedn, pre, function( req, res, next ) {

  var entry = req.entry;
  var u = req.toObject().attributes;
  if ( entry.rdns[0].uid ) {
    // this only applies for users, but for now that's what we're focusing on
    // must have a uid attribute and that uid __MUST__ match the dn uid
    var uid = req.attributes.uid || entry.rdns[0].uid;
    if ( uid === entry.rdns[0].uid ) {
      log.info("adding new account for \"%s\" now",uid);
      var userspec = {};
      for ( k in u ) {
        userspec[k] = u[k][0];
      }
      log.debug(userspec);
      var user = User.create(userspec, function(err, nuser) {
        log.trace(nuser);
        if ( err ) {
          var death = new ldap.UnwillingToPerformError(err);
          log.fatal(death);
          return next(death);
        }  
        log.info("user account created for \"%s\" sucessfully",user.uid);
        res.end();
        return next();
      });
    } else {
      err = new ldap.ConstraintViolationError();
      log.crit(err);
      return next(err);
    }
  }
});
server.search(config.basedn, pre, function(req, res, next) {
  log.debug("performing `ldapsearch` for dn: " + this.bindDN)
  log.info(req.filter);
  
  // very incomplete right now. Only supports the EqualityMatch filter type
  // and completely ignores the field list that may have been supplied by
  // the client
  var filter = req.filter.json,
      attr = filter.attribute,
      val = filter.value;

  var search = {};
  search[attr] = val;

  User.find(search,function(err,users) {
    if ( err ) { log.fatal(err) ; return next(err); }
    users.forEach(function(user){
      var ldapUser = user.getLdapEntry();
      res.send({
        dn: sprintf("uid=%s,ou=users,%s",user.uid, config.basedn),
        attributes: ldapUser[0]
      });
    });
    res.end();
    return next();
  });
});

server.exop("1.3.6.1.4.1.4203.1.11.3", function( req, res, next ) {
  log.debug("who be dat! ... performing exop `ldapwhoami`");
  var binddn = req.connection.ldap.bindDN.rdns.toString();
  res.value = "dn: " + binddn;
  log.trace(res.value);
  res.end();
  return next();
});

server.listen(port,function() {
  log.info('Standalone LDAP server started for ' + org + ' organization... listening at: %s', server.url);
  log.info("using directory with base dn: %s" , config.basedn);
  log.debug("using \"" + dbname + "\" mongodb backend database");
  /**
   * Here we check for the existence of a global admin account in our db
   * and make sure the account is part of the admin group unless account
   * enabled === false
   **/
  Group.find( { cn: "everyone" } , function( err, res ) {
    User.find({ uid: "admin" }, function( err, res) {
      if ( err ) { log.fatal(err); exit(2); }
      if ( res.length < 1 ) {
        log.info("Setting up backend \"admin\" account for the first time");
        var randompass = rand.generateKey(14);
        var sshapass = ssha.create(randompass);
        // not a posix account. Eventually I plan to completely remove this user
        // from ou=users to keep the userlist from displaying it
        var admin = new User({
          uid: "admin",
          password: sshapass,
          name: { first: "Big" , last: "Pappa" },
          roles: [ "admin" ],
          groups: [ "everyone" ],
          enabled: true,
          description: "Automatically generated administrator account",
          company: org
        });
        admin.save(function(err) {
          if ( err ) {
            var death = new ldap.UnwillingToPerformError(err);
            log.fatal(death);
            return death;
          } else {
            log.warn("root bindPW is set to \"" + randompass + "\"");
          }
          log.info("you can add more users with the openldap/ldapadd utility");
          log.info("i.e. ldapadd -H \"ldap://%s:%s\" -WD \"uid=admin,ou=users,%s\" -f newusers.ldif",dbhost,port,config.basedn);
          // User.setAccess(admin,["add","delete","view","edit"]);
          // Group.setAccess(admin,["add","delete","view","edit"]);
        });
      } else {
        log.debug("admin account name: " + res[0].uid);
      }
    });
  });
});
