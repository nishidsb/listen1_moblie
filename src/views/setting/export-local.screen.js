import React from 'react';
import { ScrollView, Clipboard } from 'react-native';
import { Button } from 'react-native-elements';
import { connect } from 'react-redux';
import styled, { withTheme } from 'styled-components';
import StateJsonConvert from '../../modules/state-json-convert';
import { ThemeFlex, PrimaryText } from '../../components';
import { showToast } from '../../modules/toast';
import { writeBackupFile } from '../../api/filemanager';

const Preview = styled(ScrollView)`
  flex: 0 200px;
  margin-bottom: 20px;
`;

class ExportLocal extends React.Component {
  static navigationOptions = ({ screenProps }) => {
    return {
      title: '备份',
      headerTintColor: screenProps.theme.primaryColor,
      headerStyle: { backgroundColor: screenProps.theme.windowColor },
    };
  };
  props: {
    playerState: Object,
    myPlaylistState: Object,
  };
  constructor(props) {
    super(props);
    this.state = { jsonString: '', isSaving: false, savedPath: '' };
    this.onPressCopy = this.onPressCopy.bind(this);
  }
  componentDidMount() {
    // generate backup json
    const jsonObj = StateJsonConvert.getJson({
      playerState: this.props.playerState,
      myPlaylistState: this.props.myPlaylistState,
    });

    this.setState({ jsonString: JSON.stringify(jsonObj) });
  }
  onPressCopy = () => {
    Clipboard.setString(this.state.jsonString);
    showToast('已复制到剪切板');
  };
  onPressSaveFile = () => {
    const d = new Date();
    const pad = n => (n < 10 ? `0${n}` : `${n}`);
    const fileName = `listen1_backup_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate()
    )}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    this.setState({ isSaving: true });
    writeBackupFile(fileName, this.state.jsonString)
      .then(path => {
        this.setState({ savedPath: path, isSaving: false });
        showToast(`已备份到: ${path}`);
      })
      .catch(() => {
        this.setState({ isSaving: false });
        showToast('备份失败:无法写入文件');
      });
  };
  render() {
    // console.log(`render ${this.constructor.name}`);

    return (
      <ThemeFlex style={{ padding: 20 }}>
        <Preview>
          <PrimaryText> {this.state.jsonString}</PrimaryText>
        </Preview>
        <Button title="一键复制" onPress={this.onPressCopy} />
        <Button
          buttonStyle={{ backgroundColor: '#4a90d9', marginTop: 8 }}
          title={this.state.isSaving ? '正在写入...' : '备份到文件'}
          disabled={this.state.isSaving}
          onPress={this.onPressSaveFile}
        />
        <PrimaryText style={{ marginTop: 10 }}>
          备份方法：点击“备份到文件”会生成 JSON 文件（优先写入 Download
          目录，无权限时写入应用专属目录），恢复时在恢复界面选择该文件即可；
          也可以点击“一键复制”复制文本。
        </PrimaryText>
        {this.state.savedPath ? (
          <PrimaryText style={{ marginTop: 6, color: '#4a90d9' }}>
            已保存: {this.state.savedPath}
          </PrimaryText>
        ) : null}
      </ThemeFlex>
    );
  }
}

const mapStateToProps = ({ playerState, myPlaylistState }) => ({
  playerState,
  myPlaylistState,
});

export default connect(mapStateToProps)(withTheme(ExportLocal));
