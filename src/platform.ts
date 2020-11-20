import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

import events = require('events');
import {spawn} from 'child_process';
const cecClient = spawn('cec-client', ['-d', '8']);
const tvEvent = new events.EventEmitter();

class CECHelper {
  public static Event_PowerOn = '01:90:00';
  public static Event_PowerStandby = '01:90:01';
  public static Event_PowerRequest = '10:8f';

  //Note: this is a broadcast event that'll turn off the TV and any linked devices.
  public static Event_PowerOffBROADCAST = '0f:36';

  static RequestPowerStatus() {
    this.writeCECCommand(this.Event_PowerRequest);
  }

  static ChangePowerStatusTo(value: boolean) {
    this.writeCECCommand(value ? this.Event_PowerOn : this.Event_PowerStandby);
  }
  
  static writeCECCommand(stringData: string) {
    cecClient.stdin.write('tx ' + stringData + '\n');
  }

  static checkCECCommand(stringData: string) {
    cecClient.stdin.write('tx ' + stringData + '\n');
  }
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class CECTVControl implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly cachedAccessories: PlatformAccessory[] = [];

  EventWaitTimeout = 5000;
  UpdatePollDelay = 2500;
  tvService;

  name = 'CEC TV';

  constructor (public readonly log: Logger, 
                public readonly config: PlatformConfig,
                public readonly api: API) {
    this.log.info('Initializing TV service');
    

    const tvName = this.config.name || 'CEC TV';
    const UUID = this.api.hap.uuid.generate(PLUGIN_NAME);    
    const tvAccessory = new api.platformAccessory(tvName, UUID);

    tvAccessory.category = this.api.hap.Categories.TELEVISION;

    this.tvService = new this.Service.Television(this.name, 'tvService');

    this.tvService.setCharacteristic(this.Characteristic.ConfiguredName, tvName);
    this.tvService.setCharacteristic(this.Characteristic.SleepDiscoveryMode, this.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    
    //Bind our power status callbacks.
    this.tvService.getCharacteristic(this.Characteristic.Active)
      .on('get', this.getPowerStatus.bind(this))
      .on('set', this.setPowerStatus.bind(this));

    this.log.info('Hooking into cec-client processes');
    //Set up a cecClient callback for every time stdout is updated.
    cecClient.stdout.on('data', data => {
      const cecTraffic = data.toString();
      this.log.info(cecTraffic);

      //Try to detect when CEC-Client changes the OSD name, and change it to something else.
      if (cecTraffic.indexOf('<< 10:47:43:45:43') !== -1) {
        cecClient.stdin.write('tx 10:47:52:50:69\n'); // Set OSD String to 'RPi'
      }

      //If a Power Off Event is written to the buffer...
      if (cecTraffic.indexOf('>> 0f:36') !== -1) {
        tvEvent.emit('POWER_OFF');
      }

      //If a Power On Event is written to the buffer...
      if (cecTraffic.indexOf('>> 01:90:00') !== -1) {
        tvEvent.emit('POWER_ON');
      }

      //If a Power Standby Event is written to the buffer...
      if (cecTraffic.indexOf('>> 01:90:01') !== -1) {
        tvEvent.emit('POWER_STANDBY');
      }

      //If an event that wants to change the current input source is written to the buffer...
      const match = />> (0f:80:\d0:00|0f:86):(\d)0:00/.exec(cecTraffic);
      if (match) {
        tvEvent.emit('INPUT_SWITCHED', match[2]);
      }

    });

    let justSwitched = false;

    tvEvent.on('POWER_ON', () => {
      if (!justSwitched) {
        this.log.debug('CEC: Power on');
        this.tvService.getCharacteristic(this.Characteristic.Active).updateValue(true);
        justSwitched = true;
        setTimeout(() => {
          justSwitched = false;
        }, this.EventWaitTimeout);
      }
    });

    tvEvent.on('POWER_OFF', () => {
      if (!justSwitched) {
        this.log.debug('CEC: Power off');
        this.tvService.getCharacteristic(this.Characteristic.Active).updateValue(false);
        justSwitched = true;
        setTimeout(() => {
          justSwitched = false;
        }, this.EventWaitTimeout);
      }
    });

    tvEvent.on('POWER_STANDBY', () => {
      if (!justSwitched) {
        this.log.debug('CEC: Power standby');

        //Standby is usually the same as off, so false works here.
        this.tvService.getCharacteristic(this.Characteristic.Active).updateValue(false);
        justSwitched = true;
        setTimeout(() => {
          justSwitched = false;
        }, this.EventWaitTimeout);
      }
    });

    tvEvent.on('INPUT_SWITCHED', port => {
      this.log.debug(`CEC: Input switched to HDMI${port}`);
      this.tvService.getCharacteristic(this.Characteristic.ActiveIdentifier).updateValue(parseInt(port));
    });

    //Set up an automatic callback to call our pollforUpdates method according to our specified poll delay.
    setInterval(this.pollForUpdates.bind(this), this.UpdatePollDelay);

    this.log.debug('Finished initializing platform:', this.config.name);

    //Add our tvService to our accessory before publishing. 
    tvAccessory.addService(this.tvService);

    //We should be done with everything, publish the service.
    this.api.publishExternalAccessories(PLUGIN_NAME, [tvAccessory]);
  }

  verify() {
    if(cecClient === null) {
      return false;
    }
  }

  loadFromConfig(config: PlatformConfig) {
    if(!config) {
      this.log.info('Failed to load information from the Homebridge Config.');
      return;
    }

    this.UpdatePollDelay = config.pollInterval as number || 2500;
  }

  pollForUpdates() {
    CECHelper.RequestPowerStatus();
  }

  getPowerStatus(callback) {
    this.log.info('Checking TV power status');

    CECHelper.RequestPowerStatus();

    callback();

    //I don't think this is actually needed.  Requesting the power status should be enough.
    /* const handler = () => {
      handler.activated = true;
      callback(null, true);
      this.log.info('TV is on');
    };
    tvEvent.once('POWER_ON', handler);

    setTimeout(() => {
      tvEvent.removeListener('POWER_ON', handler);
      if(!handler.activated) {
        callback(null, false);
        this.log.info('TV is off');
      }
    }, 1000);*/
  }

  setPowerStatus(value, callback) {
    this.log.info(`Turning TV ${value ? 'on' : 'off'}`);

    if(value === this.tvService.getCharacteristic(this.Characteristic.Active).value) {
      callback();
      this.log.info(`TV is already ${value ? 'on' : 'off'}`);
    }

    //Send the on or off signal.
    CECHelper.ChangePowerStatusTo(value);
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }
}