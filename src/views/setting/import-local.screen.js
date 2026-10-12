import React from 'react';
import { ScrollView, Clipboard, TouchableOpacity, PermissionsAndroid } from 'react-native';
import { Button } from 'react-native-elements';
import { connect } from 'react-redux';
import styled, { withTheme } from 'styled-components';
import StateJsonConvert from '../../modules/state-json-convert';
import { ThemeFlex, PrimaryText } from '../../components';
import { showToast } from '../../modules/toast';
import { listBackupFiles, readBackupFile } from '../../api/filemanager';
import { recoverData } from '../../redux/actions';

const Preview = styled(ScrollView)`
  flex: 0 160px;
  margin-bottom: 20px;
`;

const FileList = styled(ScrollView)`
  flex: 0 180px;
  margin-vertical: 10px;
  border-width: 1px;
  border-color: #8882;
`;

const FileRow = styled(TouchableOpacity)`
  padding: 10px 8px;
  border-bottom-width: 1px;
  border-color: #8882;
`;

function formatTime(mtime) {
  const d = new Date(mtime);
  const pad = n => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function formatSize(size) {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

class ImportLocal extends React.Component {
  static navigationOptions = ({ screenProps }) => {
    return {
      title: '恢复',
      headerTintColor: screenProps.theme.primaryColor,
      headerStyle: { backgroundColor: screenProps.theme.windowColor },
    };
  };
  props: {
    dispatch: Function,
  };
  constructor(props) {
    super(props);
    this.state = {
      jsonString: '',
      isValidJson: false,
      files: [],
      loadingFiles: false,
      selectedPath: '',
    };
    this.onPressPaste = this.onPressPaste.bind(this);
    this.onPressRecover = this.onPressRecover.bind(this);
    this.onPressRefresh = this.onPressRefresh.bind(this);
    this.onPressFile = this.onPressFile.bind(this);
  }

  componentDidMount() {
    this.onPressRefresh();
  }

  async onPressRefresh() {
    this.setState({ loadingFiles: true });
    try {
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
        {
          title: '存储权限',
          message: 'Listen1 需要存储权限用于读取备份文件',
          buttonPositive: '允许',
          buttonNegative: '拒绝',
        }
      );
      // app-external-dir files are listable without the permission as well
      const files = await listBackupFiles();
      this.setState({ files, loadingFiles: false });
      if (!files.length) {
        showToast('未找到备份文件');
      }
    } catch (e) {
      this.setState({ loadingFiles: false });
      showToast('读取文件列表失败');
    }
  }

  onPressFile = file => {
    this.setState({ loadingFiles: true, selectedPath: file.path });
    readBackupFile(file.path)
      .then(jsonString => {
        try {
          JSON.parse(jsonString);
        } catch (e) {
          this.setState({ loadingFiles: false, selectedPath: '', jsonString: '', isValidJson: false });
          return showToast('该文件不是有效的备份 JSON');
        }
        this.setState({ jsonString, isValidJson: true, loadingFiles: false });
        showToast(`已加载: ${file.name}`);
      })
      .catch(() => {
        this.setState({ loadingFiles: false, selectedPath: '' });
        showToast('读取文件失败');
      });
  };

  onPressPaste = () => {
    Clipboard.getString().then(jsonString => {
      try {
        JSON.parse(jsonString);
      } catch {
        this.setState({ jsonString: '', isValidJson: false });

        return showToast('未在剪切板找到可用的备份文本');
      }
      this.setState({ jsonString, isValidJson: true });

      return showToast('已粘贴');
    });
  };
  onPressRecover = () => {
    const json = JSON.parse(this.state.jsonString);
    const state = StateJsonConvert.getState(json);

    this.props.dispatch(recoverData(state));
    showToast('恢复成功,请返回');
  };
  renderFileRow = file => (
    <FileRow
      key={file.path}
      onPress={() => this.onPressFile(file)}
      style={file.path === this.state.selectedPath ? { backgroundColor: '#4a90d922' } : null}
    >
      <PrimaryText>{file.name}</PrimaryText>
      <PrimaryText style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
        {formatTime(file.mtime)} · {formatSize(file.size)}
      </PrimaryText>
    </FileRow>
  );
  render() {
    // console.log(`render ${this.constructor.name}`);

    return (
      <ThemeFlex style={{ padding: 20 }}>
        <Preview>
          <PrimaryText> {this.state.jsonString}</PrimaryText>
        </Preview>
        {!this.state.isValidJson ? (
          <Button title="从剪切板粘贴" onPress={this.onPressPaste} />
        ) : (
          <Button
            buttonStyle={{ backgroundColor: '#e1a900' }}
            title="恢复（警告：将覆盖当前数据）"
            disabled={this.state.isRecovering}
            onPress={this.onPressRecover}
          />
        )}

        <PrimaryText style={{ marginTop: 14, fontWeight: 'bold' }}>
          从文件恢复（推荐）：
        </PrimaryText>
        <Button
          clear
          small
          icon={{ name: 'refresh', type: 'foundation', size: 14 }}
          title={this.state.loadingFiles ? '正在读取文件列表...' : '刷新文件列表'}
          onPress={this.onPressRefresh}
          buttonStyle={{ alignSelf: 'flex-start', paddingVertical: 2 }}
        />
        <FileList>
          {this.state.files.map(this.renderFileRow)}
        </FileList>
        <PrimaryText style={{ marginTop: 6 }}>
          点击上方列表中的备份文件即可载入，然后点“恢复”。文件通常位于
          Download 目录（备份时生成），或应用专属目录
          Android/data/com.listen1.app/files/。
        </PrimaryText>
        <PrimaryText style={{ marginTop: 8, opacity: 0.7 }}>
          也可以复制之前备份的文本，点击“从剪切板粘贴”后恢复。
        </PrimaryText>
        <PrimaryText style={{ marginTop: 8 }}>
          警告：恢复功能将覆盖当前所有的歌单信息，请谨慎操作。
        </PrimaryText>
      </ThemeFlex>
    );
  }
}

const mapStateToProps = ({ playerState, myPlaylistState }) => ({
  playerState,
  myPlaylistState,
});

export default connect(mapStateToProps)(withTheme(ImportLocal));
